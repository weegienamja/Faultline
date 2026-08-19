// Flight Recorder API.
//
// Admin-authenticated throughout, for the same reason as the live and bisect
// routes: recording makes repeated real outbound connections from this machine,
// so an open endpoint would be a resource-abuse and SSRF primitive.
//
// One recorder per control plane. Recording is a foreground activity a person
// starts because something is happening; several concurrent recorders against
// different targets would multiply the network load the feature exists to keep
// small, and nothing in the product needs it yet.

import { createRecorder, DEFAULTS, RECORDER_STATE } from "./recorder.mjs";
import { createDeepCapture } from "./deep-capture.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { assertLiteralTargetAllowed } from "../security/target.mjs";
import { resolveConnectivityContract } from "../contracts/registry.mjs";
import { isolate } from "../bisect/adaptive.mjs";
import { EVIDENCE_KIND, evidenceRegistry } from "../analyst/registry.mjs";

const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 10 * 60_000;

export function createRecorderRouter({
  requireAdmin,
  bodyFrom,
  json,
  deepCapture = createDeepCapture(),
  makeRecorder = createRecorder,
  runBisect = isolate,
  registry = evidenceRegistry,
  logger = (event, detail) => console.error(`[recorder] ${event}`, detail ?? "")
} = {}) {
  let recorder = null;
  /** Bounded live-event fan-out for the dashboard. */
  const listeners = new Set();

  function broadcast(event) {
    // A closed incident becomes retrievable evidence for the Analyst. In memory
    // only, on the same bounded registry as bisect and live runs.
    if (event.type === "incident-closed" && recorder) {
      const incident = recorder.getIncident(event.id);
      if (incident) registry.record(EVIDENCE_KIND.INCIDENT, incident, { id: incident.id });
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
  }

  function clamp(value, fallback, min, max) {
    const numeric = Number(value ?? fallback);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(numeric, min), max);
  }

  function requireRecorder() {
    if (!recorder || recorder.state === RECORDER_STATE.STOPPED) {
      const error = new Error("The Flight Recorder is not running.");
      error.statusCode = 409;
      throw error;
    }
    return recorder;
  }

  return async function handleRecorder(req, res, url) {
    if (!url.pathname.startsWith("/api/recorder")) return false;
    requireAdmin(req);

    // --- start -------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/recorder/start") {
      if (recorder && recorder.state !== RECORDER_STATE.STOPPED) {
        const error = new Error("The Flight Recorder is already running. Stop it before starting a new capture.");
        error.statusCode = 409;
        throw error;
      }

      const payload = await bodyFrom(req);
      if (!payload.target) {
        const error = new Error("A target hostname, IP address or URL is required.");
        error.statusCode = 400;
        throw error;
      }

      // The same public-target boundary every other outbound path uses.
      const target = parseLiveTarget(String(payload.target), payload.port);
      const scope = payload.scope === "private" ? "private" : "public";
      assertLiteralTargetAllowed(target.input, target.port, scope);

      const contract = resolveConnectivityContract(payload);

      recorder = makeRecorder({
        target,
        contract,
        intervalMs: clamp(payload.intervalMs, DEFAULTS.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
        windowMs: clamp(payload.windowMs, DEFAULTS.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS),
        afterWindowMs: clamp(payload.afterWindowMs, DEFAULTS.afterWindowMs, 10_000, 5 * 60_000),
        captureOnStateChange: payload.captureOnStateChange === true,
        // Off unless asked for: it is the only contact the recorder makes
        // beyond the target itself.
        publicIpUrl: payload.samplePublicIp === true ? (payload.publicIpUrl || undefined) : null,
        deepCapture: payload.deepCapture === false ? null : deepCapture,
        onEvent: broadcast,
        logger
      });

      recorder.start();
      json(res, 201, recorder.status());
      return true;
    }

    // --- stop --------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/recorder/stop") {
      if (!recorder) {
        json(res, 200, { state: RECORDER_STATE.STOPPED, stopped: false });
        return true;
      }
      const stopped = recorder.stop();
      json(res, 200, { ...recorder.status(), stopped });
      return true;
    }

    // --- status ------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/recorder/status") {
      json(res, 200, recorder ? recorder.status() : idleStatus());
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/recorder/timeline") {
      const limit = clamp(url.searchParams.get("limit"), 120, 1, 600);
      json(res, 200, { samples: recorder ? recorder.timeline(limit) : [], state: recorder?.state ?? RECORDER_STATE.STOPPED });
      return true;
    }

    // --- manual capture ----------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/recorder/mark") {
      const active = requireRecorder();
      const payload = await bodyFrom(req);
      json(res, 202, active.mark(payload.note));
      return true;
    }

    // --- incidents ---------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/recorder/incidents") {
      json(res, 200, { incidents: recorder ? recorder.listIncidents() : [] });
      return true;
    }

    const incidentMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})$/);
    if (req.method === "GET" && incidentMatch) {
      const incident = recorder?.getIncident(incidentMatch[1]) ?? null;
      if (!incident) {
        const error = new Error(`No Flight Recorder incident ${incidentMatch[1]} is retained.`);
        error.statusCode = 404;
        throw error;
      }
      json(res, 200, incident);
      return true;
    }

    // --- hand an incident's candidate conditions to Network Bisect ----------
    //
    // The recorder observed a difference; Bisect independently tests whether
    // changing it alters the outcome. The recorder never claims causation, and
    // this route is what makes the difference testable rather than rhetorical.
    const bisectMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})\/bisect$/);
    if (req.method === "POST" && bisectMatch) {
      const incident = recorder?.getIncident(bisectMatch[1]) ?? null;
      if (!incident) {
        const error = new Error(`No Flight Recorder incident ${bisectMatch[1]} is retained.`);
        error.statusCode = 404;
        throw error;
      }

      const axes = incident.candidateDiscriminators?.bisectAxes ?? [];
      if (!axes.length) {
        const error = new Error("This incident produced no condition that Network Bisect can vary.");
        error.statusCode = 409;
        throw error;
      }

      const payload = await bodyFrom(req);
      const target = incident.target?.input || incident.target?.host;
      assertLiteralTargetAllowed(target, incident.target?.port, "public");

      const report = await runBisect(target, {
        repeat: clamp(payload.repeat, 3, 1, 10),
        confirmPairs: clamp(payload.confirmPairs, 3, 1, 10),
        // Only the conditions the recorder actually saw change.
        axes
      });

      const runId = registry.record(EVIDENCE_KIND.BISECT, report);
      json(res, 201, {
        incidentId: incident.id,
        requestedAxes: axes,
        report: { ...report, id: report.id || runId },
        note: "Network Bisect tested the conditions the recorder observed changing. A confirmed discriminator establishes association, not cause."
      });
      return true;
    }

    // --- live event stream --------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/recorder/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write(": open\n\n");

      const listener = event => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      listeners.add(listener);

      // Heartbeat so an idle recorder does not look like a dead connection.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 20_000);
      heartbeat.unref?.();

      req.on("close", () => {
        listeners.delete(listener);
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      });
      return true;
    }

    return false;
  };
}

function idleStatus() {
  return {
    state: RECORDER_STATE.STOPPED,
    target: null,
    coverage: null,
    incidents: [],
    activeIncident: null,
    retention: "In-memory only. Nothing is written to disk and the buffer is discarded when the process exits."
  };
}
