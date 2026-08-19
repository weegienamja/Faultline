// Faultline Analyst API.
//
// Admin-authenticated on every route, matching the rule the live and bisect
// routers already follow: anything that reads real network evidence or drives
// a local runtime is gated on the control-plane credential.
//
// There is no proxy route here. The browser cannot name an Ollama host, a
// path, or a payload - it names a question and a screen, and this module
// decides everything else. The only outbound destination is the loopback
// endpoint fixed in the transport.
//
// Streaming is Server-Sent Events over the existing Node http server: no
// framework, no WebSocket upgrade, and it degrades cleanly if the client
// disconnects mid-answer.

import { createOllamaClient } from "./ollama.mjs";
import { DEFAULT_MODEL, assertModelName, parsePullProgress, resolveStatus } from "./lifecycle.mjs";
import { createAnalystGateway, starterQuestions } from "./gateway.mjs";
import { buildDocIndex } from "./docs.mjs";
import { conversations } from "./conversation.mjs";
import { evidenceRegistry } from "./registry.mjs";
import { TOOLS } from "./tools.mjs";

/** One concurrent model download is enough; more would thrash the disk. */
let activePull = null;

export function createAnalystRouter({
  requireAdmin,
  bodyFrom,
  json,
  store,
  client = null,
  registry = evidenceRegistry,
  conversationStore = conversations,
  model = process.env.FAULTLINE_ANALYST_MODEL || DEFAULT_MODEL,
  docsPromise = null,
  logger = (event, detail) => console.error(`[analyst] ${event}`, detail ?? "")
} = {}) {
  // Constructing the client validates the endpoint once, at startup, so a bad
  // FAULTLINE_ANALYST_ENDPOINT fails loudly rather than at first question.
  let transport = client;
  let transportError = null;
  try {
    transport = client || createOllamaClient();
  } catch (error) {
    transportError = error;
    logger("analyst.endpoint_invalid", { message: error?.message });
  }

  const docs = docsPromise || buildDocIndex().catch(error => {
    logger("analyst.docs_index_failed", { message: error?.message });
    return null;
  });

  let gateway = null;
  async function getGateway() {
    if (!gateway) {
      gateway = createAnalystGateway({
        client: transport,
        store,
        registry,
        docs: await docs,
        conversations: conversationStore,
        model,
        logger
      });
    }
    return gateway;
  }

  function sseOpen(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Without this an intermediary can hold the whole stream and defeat it.
      "x-accel-buffering": "no"
    });
    // Flush headers immediately so the client shows a live state.
    res.write(": open\n\n");
  }

  function sseSend(res, event) {
    if (res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  return async function handleAnalyst(req, res, url) {
    if (!url.pathname.startsWith("/api/analyst")) return false;
    requireAdmin(req);

    if (transportError) {
      const error = new Error(transportError.message);
      error.statusCode = 500;
      throw error;
    }

    // --- status ------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/analyst/status") {
      const status = await resolveStatus(transport, { model });
      json(res, 200, {
        ...status,
        // Product-level truth the UI states plainly, independent of runtime state.
        privacy: {
          cloudInference: false,
          telemetry: false,
          note: "Runs locally through Ollama on this machine. No prompt or evidence leaves it."
        },
        conversationLimits: { retainedTurns: 8, persisted: false },
        pullInProgress: Boolean(activePull)
      });
      return true;
    }

    // --- capability description --------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/analyst/capabilities") {
      json(res, 200, {
        readOnly: true,
        writeTools: [],
        note: "The Analyst has read-only tools only. It cannot change the network, cases, evidence, probes or environments.",
        tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, why: tool.why })),
        starterQuestions: Object.fromEntries(
          ["overview", "live", "recorder", "bisect", "topology", "cases", "evidence", "change", "environment", "probes", "settings"]
            .map(view => [view, starterQuestions(view)])
        )
      });
      return true;
    }

    // --- model installation -------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/analyst/install") {
      if (activePull) {
        const error = new Error("A model download is already in progress.");
        error.statusCode = 409;
        throw error;
      }

      const payload = await bodyFrom(req);
      // The requested name is validated against the model-name grammar and the
      // cloud-tag ban before it reaches the runtime.
      const requested = assertModelName(payload.model || model, { field: "model" });

      sseOpen(res);
      activePull = requested;
      const controller = new AbortController();
      req.on("close", () => controller.abort(new Error("client disconnected")));

      try {
        sseSend(res, { type: "status", phase: "starting", model: requested, label: "Contacting local Ollama" });
        for await (const frame of transport.pull(requested, { signal: controller.signal })) {
          const progress = parsePullProgress(frame);
          if (!progress) continue;
          if (progress.error) {
            logger("analyst.pull_failed", { model: requested, status: progress.status });
            sseSend(res, { type: "error", message: "The model download did not complete.", detail: progress.status });
            break;
          }
          sseSend(res, { type: "progress", model: requested, ...progress });
          if (progress.done) {
            sseSend(res, { type: "done", model: requested });
            break;
          }
        }
      } catch (error) {
        logger("analyst.pull_error", { model: requested, message: error?.message });
        sseSend(res, {
          type: "error",
          message: controller.signal.aborted
            ? "The download was interrupted."
            : "The model download could not start. Check that Ollama is running."
        });
      } finally {
        activePull = null;
        if (!res.writableEnded) res.end();
      }
      return true;
    }

    // --- conversation reset -------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/analyst/conversation/clear") {
      const payload = await bodyFrom(req);
      const id = String(payload.conversationId || "").slice(0, 120);
      const cleared = id ? conversationStore.clear(id) : false;
      json(res, 200, { cleared, conversationId: id || null });
      return true;
    }

    // --- ask (streamed) -----------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/analyst/ask") {
      const payload = await bodyFrom(req);
      const status = await resolveStatus(transport, { model });
      if (!status.ready) {
        // A structured refusal, not a 500: an unavailable Analyst is normal.
        json(res, 503, {
          error: status.detail,
          state: status.state,
          remedy: status.remedy,
          analystAvailable: false
        });
        return true;
      }

      const analyst = await getGateway();
      const controller = new AbortController();
      req.on("close", () => controller.abort(new Error("client disconnected")));

      sseOpen(res);
      try {
        for await (const event of analyst.ask({
          question: payload.question,
          view: payload.view,
          conversationId: String(payload.conversationId || "").slice(0, 120) || null,
          signal: controller.signal
        })) {
          if (!sseSend(res, event)) break;
        }
      } catch (error) {
        // Validation errors reach here before the first event is sent.
        logger("analyst.ask_failed", { message: error?.message });
        sseSend(res, {
          type: "error",
          message: error?.statusCode === 400
            ? error.message
            : "The Analyst could not complete this request."
        });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return true;
    }

    return false;
  };
}
