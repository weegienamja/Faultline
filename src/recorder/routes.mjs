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
import { summariseIncident } from "./incident.mjs";
import { createSimulationSampler, listScenarios, loadScenario } from "./simulate.mjs";
import { buildBisectAttachment, summariseAttachment } from "./attachments.mjs";
import { buildCapsule, capsuleFilename } from "../evidence/capsule.mjs";
import { renderCapsuleHtml } from "../evidence/capsule-html.mjs";
import { assertRedactionMode } from "../evidence/redaction.mjs";
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
  store = null,
  faultlineVersion = "unknown",
  // Closed incidents are written to the store so an investigation survives a
  // restart. The rolling sample buffer is never persisted - that distinction is
  // what keeps this a recorder rather than a time-series database. Set
  // FAULTLINE_RECORDER_PERSIST=0 to keep incidents in memory only.
  persistIncidents = process.env.FAULTLINE_RECORDER_PERSIST !== "0",
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
    if (event.type === "incident-closed" && recorder) {
      const incident = recorder.getIncident(event.id);
      if (incident) {
        // Retrievable by the Analyst for this process.
        registry.record(EVIDENCE_KIND.INCIDENT, incident, { id: incident.id });
        // And durable, so the investigation outlives the control plane.
        if (persistIncidents && store?.putIncident) {
          store.putIncident(incident).catch(error => logger("recorder.persist_failed", { id: incident.id, message: error?.message }));
        }
      }
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

  /** Live incidents first, then persisted ones, without duplicates. */
  async function listAllIncidents() {
    const live = recorder ? recorder.listIncidents() : [];
    if (!persistIncidents || !store?.listIncidents) return live;
    const seen = new Set(live.map(entry => entry.id));
    const stored = (await store.listIncidents()).filter(entry => !seen.has(entry.id));
    // Persisted incidents are summarised with the same function the live
            // recorder uses, so a restored incident is indistinguishable in shape.
    return [...live, ...stored.map(incident => ({ ...summariseIncident(incident), persisted: true }))];
  }

  async function listAttachments(incidentId) {
    if (!store?.listIncidentEvidence) return [];
    try {
      return await store.listIncidentEvidence(incidentId);
    } catch {
      return [];
    }
  }

  async function findIncident(id) {
    return recorder?.getIncident(id)
      ?? (persistIncidents && store?.getIncident ? await store.getIncident(id) : null);
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

    // --- available simulation scenarios ------------------------------------
    if (req.method === "GET" && url.pathname === "/api/recorder/scenarios") {
      json(res, 200, {
        scenarios: await listScenarios(),
        note: "A simulation feeds scripted samples into the real recorder engine. Incidents it produces are marked simulated at every layer and are not evidence about any real network."
      });
      return true;
    }

    // --- start -------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/recorder/start") {
      if (recorder && recorder.state !== RECORDER_STATE.STOPPED) {
        const error = new Error("The Flight Recorder is already running. Stop it before starting a new capture.");
        error.statusCode = 409;
        throw error;
      }

      const payload = await bodyFrom(req);

      // A simulation names a built-in scenario. The API deliberately does NOT
      // accept a filesystem path: a request must never be able to name a file
      // on the server. The CLI, where the operator chose the file, may.
      const simulation = payload.simulate ? await loadScenario(payload.simulate) : null;

      const requestedTarget = simulation ? simulation.target : payload.target;
      if (!requestedTarget) {
        const error = new Error("A target hostname, IP address or URL is required.");
        error.statusCode = 400;
        throw error;
      }

      const target = parseLiveTarget(String(requestedTarget), simulation ? simulation.port : payload.port);
      // A simulation makes no outbound connections at all, but the target still
      // goes through the same boundary so a scenario cannot smuggle in a host
      // the product would otherwise refuse to name.
      const scope = payload.scope === "private" ? "private" : "public";
      assertLiteralTargetAllowed(target.input, target.port, scope);

      const contract = resolveConnectivityContract(payload);

      recorder = makeRecorder({
        target,
        contract,
        // A scenario defines its own cadence so its phase timings play out as
        // written; an explicit request still wins.
        intervalMs: clamp(payload.intervalMs ?? simulation?.intervalMs, DEFAULTS.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
        windowMs: clamp(payload.windowMs, DEFAULTS.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS),
        afterWindowMs: clamp(payload.afterWindowMs, DEFAULTS.afterWindowMs, 10_000, 5 * 60_000),
        captureOnStateChange: payload.captureOnStateChange === true,
        // Off unless asked for: it is the only contact the recorder makes
        // beyond the target itself.
        publicIpUrl: simulation ? null : (payload.samplePublicIp === true ? (payload.publicIpUrl || undefined) : null),
        // The scripted source replaces the real sampler at the same boundary.
        sampler: simulation ? createSimulationSampler(simulation) : undefined,
        simulation,
        // A simulated incident must not carry a real measurement inside it:
        // that would mix genuine evidence into a fabricated record.
        deepCapture: simulation || payload.deepCapture === false ? null : deepCapture,
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
      const base = recorder ? recorder.status() : idleStatus();
      json(res, 200, {
        ...base,
        incidents: await listAllIncidents(),
        incidentsPersisted: persistIncidents,
        retention: persistIncidents
          ? "The rolling sample buffer is in memory only. Closed incidents are written to the Faultline store and survive a restart."
          : "In-memory only. Nothing is written to disk and the buffer is discarded when the process exits."
      });
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
    //
    // Served from the live recorder first, then the store. After a restart the
    // recorder is empty but the incidents are still there.
    if (req.method === "GET" && url.pathname === "/api/recorder/incidents") {
      json(res, 200, { incidents: await listAllIncidents() });
      return true;
    }

    const incidentMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})$/);
    if (req.method === "GET" && incidentMatch) {
      const incident = await findIncident(incidentMatch[1]);
      if (!incident) {
        const error = new Error(`No Flight Recorder incident ${incidentMatch[1]} is retained.`);
        error.statusCode = 404;
        throw error;
      }
      json(res, 200, {
        ...incident,
        // Listed alongside rather than merged in: the incident record itself
        // stays exactly as it was frozen.
        evidence: (await listAttachments(incident.id)).map(summariseAttachment)
      });
      return true;
    }

    const evidenceMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})\/evidence$/);
    if (req.method === "GET" && evidenceMatch) {
      json(res, 200, { incidentId: evidenceMatch[1], evidence: await listAttachments(evidenceMatch[1]) });
      return true;
    }

    // --- export a portable incident capsule ---------------------------------
    //
    // One self-contained file. Never depends on the Analyst: export must work
    // with no model installed and no network, because the evidence is the
    // product.
    const capsuleMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})\/capsule$/);
    if (req.method === "GET" && capsuleMatch) {
      const incident = await findIncident(capsuleMatch[1]);
      if (!incident) {
        const error = new Error(`No Flight Recorder incident ${capsuleMatch[1]} is retained.`);
        error.statusCode = 404;
        throw error;
      }

      const redaction = assertRedactionMode(url.searchParams.get("redaction") || "none");
      const capsule = buildCapsule({
        incident,
        attachments: await listAttachments(incident.id),
        redaction,
        faultlineVersion
      });

      if (url.searchParams.get("format") === "json") {
        json(res, 200, capsule);
        return true;
      }

      const html = renderCapsuleHtml(capsule);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${capsuleFilename(incident.id)}"`
      });
      res.end(html);
      return true;
    }

    // --- hand an incident's candidate conditions to Network Bisect ----------
    //
    // The recorder observed a difference; Bisect independently tests whether
    // changing it alters the outcome. The recorder never claims causation, and
    // this route is what makes the difference testable rather than rhetorical.
    const bisectMatch = url.pathname.match(/^\/api\/recorder\/incidents\/([A-Za-z0-9-]{1,40})\/bisect$/);
    if (req.method === "POST" && bisectMatch) {
      const incident = await findIncident(bisectMatch[1]);
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

      // Durable, and separate from the frozen incident. Before this, a Bisect
      // result lived only in the in-memory Analyst registry, so restarting the
      // control plane left an incident that recorded a failure with no trace of
      // the experiment that isolated it.
      const attachment = buildBisectAttachment({ incident, report, requestedAxes: axes });
      if (store?.putIncidentEvidence) {
        await store.putIncidentEvidence(attachment).catch(error => {
          logger("recorder.attachment_persist_failed", { id: attachment.id, message: error?.message });
        });
      }

      json(res, 201, {
        incidentId: incident.id,
        evidenceId: attachment.id,
        requestedAxes: axes,
        // The incident may be simulated, but this Bisect run is not: it made
        // real connections from this machine. Saying so prevents the two halves
        // of the chain being mistaken for each other in either direction.
        incidentSimulated: incident.simulated === true,
        bisectSimulated: false,
        report: { ...report, id: report.id || runId },
        note: incident.simulated
          ? "The incident was simulated; this Network Bisect run was not. It made real connections from this machine to test the conditions the scenario demonstrated. A confirmed discriminator establishes association, not cause."
          : "Network Bisect tested the conditions the recorder observed changing. A confirmed discriminator establishes association, not cause."
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
