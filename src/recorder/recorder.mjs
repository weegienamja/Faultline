// The Flight Recorder engine.
//
// A scheduler and a state machine. All the judgement lives in triggers.mjs and
// incident.mjs; this module decides when to sample, when to freeze, and when an
// incident is finished.
//
// Design constraints that shaped it:
//
//   * Sampling must not stop while an incident is being captured. The AFTER
//     window is evidence too, and a recorder that blocks during the interesting
//     part records nothing about recovery.
//   * The deep capture runs concurrently and is never awaited by the tick loop.
//     It is the one heavyweight operation, and it must not delay or skew the
//     lightweight cadence it sits inside.
//   * A tick that overruns its interval must not queue up behind itself.
//     Sampling is self-scheduling rather than setInterval for that reason.
//   * Everything is bounded: buffer, incident count, deep captures in flight,
//     and a cooldown so a flapping target produces one incident rather than
//     forty.

import { createSampleBuffer } from "./buffer.mjs";
import { takeSample, parseLiveTarget, STATE } from "./sample.mjs";
import { detectTriggers, opensIncident, primaryTrigger, TRIGGER } from "./triggers.mjs";
import { buildIncident, nextIncidentId, summariseIncident } from "./incident.mjs";
import { RESULT } from "../bisect/results.mjs";

export const RECORDER_STATE = Object.freeze({
  STOPPED: "stopped",
  RECORDING: "recording",
  CAPTURING: "capturing"
});

export const DEFAULTS = Object.freeze({
  intervalMs: 3_000,
  windowMs: 3 * 60_000,
  slowEveryTicks: 5,
  afterWindowMs: 60_000,
  cooldownMs: 60_000,
  maxIncidents: 10,
  captureOnStateChange: false,
  publicIpUrl: null
});

export function createRecorder({
  target,
  contract = null,
  intervalMs = DEFAULTS.intervalMs,
  windowMs = DEFAULTS.windowMs,
  slowEveryTicks = DEFAULTS.slowEveryTicks,
  afterWindowMs = DEFAULTS.afterWindowMs,
  cooldownMs = DEFAULTS.cooldownMs,
  maxIncidents = DEFAULTS.maxIncidents,
  captureOnStateChange = DEFAULTS.captureOnStateChange,
  publicIpUrl = DEFAULTS.publicIpUrl,
  deepCapture = null,
  sampler = takeSample,
  now = () => Date.now(),
  clock = { setTimeout, clearTimeout },
  onEvent = null,
  logger = null
} = {}) {
  const parsed = typeof target === "string" ? parseLiveTarget(target) : target;
  if (!parsed?.host) throw new Error("Flight Recorder requires a target.");

  const buffer = createSampleBuffer({ windowMs, now });
  const incidents = [];

  let state = RECORDER_STATE.STOPPED;
  let timer = null;
  let seq = 0;
  let carried = null;
  let startedAt = null;
  let lastError = null;
  let lastTriggerAt = 0;
  let pendingManual = null;

  /** The incident currently collecting DURING/AFTER samples, if any. */
  let active = null;
  let capturesInFlight = 0;

  function emit(type, detail) {
    try {
      onEvent?.({ type, at: new Date().toISOString(), ...detail });
    } catch {
      // A listener must never break the recorder.
    }
  }

  function log(event, detail) {
    logger?.(event, detail);
  }

  async function tick() {
    const isSlow = seq % slowEveryTicks === 0;
    try {
      const result = await sampler({
        target: parsed,
        seq,
        slow: isSlow,
        carried,
        contract,
        publicIpUrl
      });
      carried = result.carried;
      const sample = result.sample;
      seq += 1;

      const previous = buffer.latest();
      buffer.push(sample);
      emit("sample", { sample });

      // Feed any open incident before evaluating new triggers, so the window
      // that captures the failure also captures what happened next.
      if (active) collectIntoIncident(sample);

      const fired = pendingManual
        ? [pendingManual, ...detectTriggers(previous, sample)]
        : detectTriggers(previous, sample);
      pendingManual = null;

      if (fired.length) {
        for (const trigger of fired) emit("trigger", { trigger });
        maybeOpenIncident(fired, sample);
      }

      lastError = null;
    } catch (error) {
      // A failed sample is a gap in the record, not the end of recording.
      lastError = String(error?.message || error).slice(0, 200);
      log("recorder.sample_failed", { message: lastError });
      emit("sample-error", { message: lastError });
    } finally {
      if (state !== RECORDER_STATE.STOPPED) {
        // Self-scheduling: a slow tick delays the next one rather than stacking.
        timer = clock.setTimeout(tick, intervalMs);
        timer?.unref?.();
      }
    }
  }

  function maybeOpenIncident(fired, sample) {
    if (active) return;

    const trigger = primaryTrigger(fired);
    if (!opensIncident(trigger, { captureOnStateChange })) return;

    // Cooldown stops a flapping target producing an incident per tick. Manual
    // capture bypasses it: the operator asked, explicitly.
    if (trigger.type !== TRIGGER.MANUAL && now() - lastTriggerAt < cooldownMs) {
      emit("trigger-suppressed", { trigger, reason: "cooldown" });
      return;
    }
    lastTriggerAt = now();

    // Freeze BEFORE the trigger sample so continued sampling and ring eviction
    // cannot erase the healthy window this incident is compared against.
    const before = buffer.freezeBefore(sample.at);

    active = {
      id: nextIncidentId(new Date(sample.at ? Date.parse(sample.at) : now())),
      trigger,
      allTriggers: fired,
      before,
      during: [structuredClone(sample)],
      after: [],
      openedAt: now(),
      deepCapture: null,
      recoveredAt: null
    };

    state = RECORDER_STATE.CAPTURING;
    emit("incident-open", { id: active.id, trigger });
    log("recorder.incident_open", { id: active.id, trigger: trigger.type });

    startDeepCapture(active);
  }

  /**
   * Run the heavyweight diagnostic alongside continued sampling.
   * Never awaited by the tick loop, and never allowed to reject into it.
   */
  function startDeepCapture(incident) {
    if (typeof deepCapture !== "function") return;
    if (capturesInFlight > 0) {
      incident.deepCapture = { available: false, reason: "Another deep capture was already running." };
      return;
    }

    capturesInFlight += 1;
    emit("deep-capture-start", { id: incident.id });

    Promise.resolve()
      .then(() => deepCapture({ target: parsed, contract, incidentId: incident.id }))
      .then(result => {
        incident.deepCapture = { available: true, ...result };
        emit("deep-capture-done", { id: incident.id });
      })
      .catch(error => {
        log("recorder.deep_capture_failed", { id: incident.id, message: error?.message });
        incident.deepCapture = {
          available: false,
          // Product wording; the technical detail stays in the log.
          reason: "The deeper diagnostic could not be completed during this incident."
        };
        emit("deep-capture-failed", { id: incident.id });
      })
      .finally(() => {
        capturesInFlight -= 1;
      });
  }

  function collectIntoIncident(sample) {
    const copy = structuredClone(sample);
    const reachable = sample.connectivity?.targetTcp?.state === RESULT.PASS;

    if (!active.recoveredAt && reachable && sample.state === STATE.HEALTHY) {
      active.recoveredAt = now();
      emit("incident-recovered", { id: active.id, at: sample.at });
    }

    if (active.recoveredAt) active.after.push(copy);
    else active.during.push(copy);

    // Close once the after-window has elapsed since recovery, or since the
    // trigger if it never recovered - an incident that never ends is a leak.
    const since = active.recoveredAt ?? active.openedAt;
    if (now() - since >= afterWindowMs) closeIncident(active.recoveredAt ? "recovered" : "after_window_elapsed");
  }

  function closeIncident(reason) {
    if (!active) return null;

    const incident = buildIncident({
      id: active.id,
      target: parsed,
      trigger: active.trigger,
      allTriggers: active.allTriggers,
      before: active.before,
      during: active.during,
      after: active.after,
      deepCapture: active.deepCapture,
      contract,
      closedAt: new Date().toISOString(),
      closeReason: reason
    });

    incidents.unshift(incident);
    incidents.length = Math.min(incidents.length, maxIncidents);

    active = null;
    if (state !== RECORDER_STATE.STOPPED) state = RECORDER_STATE.RECORDING;

    emit("incident-closed", { id: incident.id, reason });
    log("recorder.incident_closed", { id: incident.id, reason });
    return incident;
  }

  return {
    get state() { return state; },
    get target() { return { host: parsed.host, port: parsed.port, input: parsed.input }; },

    start() {
      if (state !== RECORDER_STATE.STOPPED) return false;
      state = RECORDER_STATE.RECORDING;
      startedAt = new Date().toISOString();
      seq = 0;
      emit("started", { target: parsed.host });
      // First sample immediately: a recorder that records nothing for the first
      // interval is useless to someone who started it because it is happening.
      void tick();
      return true;
    },

    stop() {
      if (state === RECORDER_STATE.STOPPED) return false;
      state = RECORDER_STATE.STOPPED;
      if (timer) clock.clearTimeout(timer);
      timer = null;
      // An incident still open at stop is preserved rather than discarded.
      if (active) closeIncident("recorder_stopped");
      emit("stopped", {});
      return true;
    },

    /**
     * Operator-initiated capture. Applied on the next tick so the incident is
     * anchored to a real sample rather than to a synthetic one.
     */
    mark(note = null) {
      if (state === RECORDER_STATE.STOPPED) {
        const error = new Error("The Flight Recorder is not running.");
        error.statusCode = 409;
        throw error;
      }
      pendingManual = {
        type: TRIGGER.MANUAL,
        at: new Date().toISOString(),
        summary: "Manual capture requested",
        detail: note ? String(note).slice(0, 300) : null
      };
      emit("mark", { note: pendingManual.detail });
      return { accepted: true, note: pendingManual.detail };
    },

    status() {
      return {
        state,
        target: { host: parsed.host, port: parsed.port },
        contract: contract ? { id: contract.id, version: contract.version ?? null } : null,
        startedAt,
        coverage: buffer.coverage(),
        config: { intervalMs, windowMs, slowEveryTicks, afterWindowMs, cooldownMs, captureOnStateChange, publicIpSampling: Boolean(publicIpUrl) },
        latest: buffer.latest(),
        activeIncident: active ? { id: active.id, trigger: active.trigger.type, openedAt: new Date(active.openedAt).toISOString() } : null,
        incidents: incidents.map(summariseIncident),
        lastError,
        // Stated plainly: this is a short in-memory window, not monitoring.
        retention: "In-memory only. Nothing is written to disk and the buffer is discarded when the process exits."
      };
    },

    timeline(limit = 120) {
      return buffer.freeze().slice(-limit);
    },

    listIncidents() {
      return incidents.map(summariseIncident);
    },

    getIncident(id) {
      return incidents.find(incident => incident.id === id) ?? null;
    },

    latestIncident() {
      return incidents[0] ?? null;
    },

    // Exposed for tests and for the CLI's synchronous shutdown path.
    __closeActiveIncident: closeIncident
  };
}
