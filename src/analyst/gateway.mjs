// Analyst gateway.
//
// Owns the whole request: validate the caller's context, let the model retrieve
// evidence through read-only tools, then produce a schema-constrained answer
// and stream it.
//
// Two phases rather than one, deliberately:
//
//   Phase 1 - retrieval. Tools enabled, no output schema. Partial text here is
//             useless to a reader, so it is not streamed.
//   Phase 2 - answer. Tools disabled, output schema applied, streamed. With
//             tools still attached some models keep calling them instead of
//             answering; removing them makes the final turn decisive.
//
// The reference table is assembled from real tool results during phase 1 and
// used to validate citations in phase 2, so the model cannot cite evidence it
// never retrieved.

import { buildSystemPrompt, STRUCTURED_INSTRUCTION } from "./prompt.mjs";
import { RESPONSE_SCHEMA, extractPartialAnswer, parseAnalystResponse } from "./schema.mjs";
import { executeTool, readOnlyStore, toolDeclarations } from "./tools.mjs";
import { DEFAULT_MODEL, assertModelName } from "./lifecycle.mjs";
import { AnalystTransportError } from "./ollama.mjs";

/** Screens the drawer may claim to be on. An unknown view is not trusted. */
export const KNOWN_VIEWS = Object.freeze({
  overview: "Overview",
  live: "Live Diagnostics",
  recorder: "Flight Recorder",
  bisect: "Network Bisect",
  topology: "Topology & Paths",
  cases: "Cases",
  evidence: "Evidence",
  change: "Change Assurance",
  environment: "Environment",
  probes: "Probe Fleet",
  settings: "Settings"
});

const MAX_QUESTION_CHARS = 2_000;
const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS = 8;
/** Idle unload window. Long enough to keep a conversation responsive, short
 *  enough that several GB are not pinned after someone walks away. */
const KEEP_ALIVE = "12m";

export function assertQuestion(value) {
  const question = String(value ?? "").trim();
  if (!question) {
    const error = new Error("A question is required.");
    error.statusCode = 400;
    throw error;
  }
  if (question.length > MAX_QUESTION_CHARS) {
    const error = new Error(`A question may be at most ${MAX_QUESTION_CHARS} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return question;
}

/**
 * Normalise the browser-supplied view context.
 *
 * This is explicit fields only - never DOM or HTML - and each one is bounded
 * and pattern-checked, because it is attacker-influenceable input that ends up
 * inside the system prompt.
 */
export function normaliseViewContext(input) {
  const raw = input && typeof input === "object" ? input : {};
  const view = Object.hasOwn(KNOWN_VIEWS, String(raw.view)) ? String(raw.view) : "overview";
  const safe = (value, pattern, max) => {
    const text = String(value ?? "").trim();
    if (!text || text.length > max || !pattern.test(text)) return null;
    return text;
  };
  return {
    view,
    label: KNOWN_VIEWS[view],
    target: safe(raw.target, /^[A-Za-z0-9._:\-[\]/]+$/, 260),
    activeRunId: safe(raw.activeRunId, /^[A-Za-z0-9_.:-]+$/, 120),
    activeCaseId: safe(raw.activeCaseId, /^[A-Za-z0-9_.:-]+$/, 120)
  };
}

/** Page-aware starter questions. Kept server-side so wording stays consistent. */
export function starterQuestions(view) {
  const byView = {
    overview: ["What looks unhealthy right now?", "Explain the current diagnosis.", "What should I investigate first?"],
    live: ["What actually failed?", "What is observed versus inferred?", "What evidence ruled out DNS?"],
    bisect: ["Explain this result.", "Why was this experiment chosen?", "What evidence ruled out DNS?", "What should I inspect next?"],
    topology: ["Explain this path.", "What is observed versus inferred?", "Where does the evidence change?"],
    cases: ["Summarise this incident.", "What evidence supports the conclusion?", "What changed?"],
    evidence: ["What does this evidence package contain?", "What is deterministic here?"],
    change: ["What changed between the two runs?", "Is this a regression or an improvement?"],
    probes: ["Which probes are unhealthy?", "Why was a vantage skipped?"],
    environment: ["What does this environment cover?", "Which targets need a private probe?"],
    // Flight Recorder is not implemented. Offering "what happened before the
    // outage" here would imply captured history that does not exist.
    recorder: ["What is the Flight Recorder for?", "What does Faultline capture today?"],
    settings: ["Where does Faultline's evidence come from?", "What does the Analyst have access to?"]
  };
  return byView[view] || byView.overview;
}

export function createAnalystGateway({
  client,
  store,
  registry,
  docs = null,
  conversations,
  model = process.env.FAULTLINE_ANALYST_MODEL || DEFAULT_MODEL,
  maxToolRounds = MAX_TOOL_ROUNDS,
  logger = null
}) {
  const modelName = assertModelName(model);
  const reader = readOnlyStore(store);

  function log(event, detail) {
    // Technical detail stays in logs; the UI only ever sees product wording.
    logger?.(event, detail);
  }

  /**
   * Run one Analyst question, yielding events as they happen.
   * Never throws for model or tool faults - it yields an `error` event so the
   * drawer can render a clean state.
   */
  async function *ask({ question, view, conversationId = null, signal = null }) {
    const asked = assertQuestion(question);
    const context = normaliseViewContext(view);
    const toolContext = { view: context, store: reader, registry, docs };

    const messages = [
      { role: "system", content: buildSystemPrompt({ view: context, model: modelName }) },
      ...(conversationId ? conversations.history(conversationId) : []),
      { role: "user", content: asked }
    ];

    const knownRefs = new Map();
    const used = [];
    let calls = 0;

    try {
      // --- Phase 1: retrieval ------------------------------------------------
      yield { type: "status", phase: "retrieving", detail: "Retrieving Faultline evidence" };

      for (let round = 0; round < maxToolRounds; round += 1) {
        const reply = await client.chat({
          model: modelName,
          messages,
          tools: toolDeclarations(),
          think: false,
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0.2 }
        }, { signal });

        const message = reply?.message || {};
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!toolCalls.length) {
          // The model answered directly. Keep it as context for the final pass.
          if (message.content) messages.push({ role: "assistant", content: String(message.content).slice(0, 4000) });
          break;
        }

        messages.push({ role: "assistant", content: message.content || "", tool_calls: toolCalls });

        for (const call of toolCalls.slice(0, MAX_TOOL_CALLS - calls)) {
          calls += 1;
          const name = call?.function?.name;
          const outcome = await executeTool(name, call?.function?.arguments, toolContext);

          if (outcome.ok) {
            for (const ref of collectRefsFrom(outcome.result)) {
              if (!knownRefs.has(ref.ref)) knownRefs.set(ref.ref, ref);
            }
          }
          used.push({
            name: typeof name === "string" ? name.slice(0, 60) : "unknown",
            ok: outcome.ok,
            available: outcome.ok ? outcome.result?.available !== false : false,
            reason: outcome.ok ? outcome.result?.reason ?? null : outcome.message
          });
          log("analyst.tool", { tool: name, ok: outcome.ok, error: outcome.error || null });

          yield {
            type: "tool",
            name: used.at(-1).name,
            ok: outcome.ok,
            available: used.at(-1).available,
            detail: used.at(-1).reason
          };

          messages.push({
            role: "tool",
            // Some Ollama builds match tool replies by name; harmless when unused.
            tool_name: used.at(-1).name,
            content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
          });
        }

        if (calls >= MAX_TOOL_CALLS) break;
      }

      // --- Phase 2: structured, streamed answer ------------------------------
      yield { type: "status", phase: "answering", detail: "Composing answer" };

      const refList = [...knownRefs.keys()];
      messages.push({
        role: "user",
        content: refList.length
          ? `${STRUCTURED_INSTRUCTION}\n\nValid evidence ids for this answer: ${refList.join(", ")}. Do not cite any other id.`
          : `${STRUCTURED_INSTRUCTION}\n\nNo evidence ids were retrieved. Leave every evidenceIds and basis array empty and record the missing evidence in limitations.`
      });

      let buffer = "";
      let emitted = "";
      for await (const chunk of client.chatStream({
        model: modelName,
        messages,
        format: RESPONSE_SCHEMA,
        think: false,
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0.2 }
      }, { signal })) {
        const piece = chunk?.message?.content;
        if (typeof piece === "string" && piece) {
          buffer += piece;
          // Stream the prose out of the growing JSON so the drawer shows an
          // answer forming rather than raw object syntax.
          const answer = extractPartialAnswer(buffer);
          if (answer.length > emitted.length) {
            yield { type: "answer_delta", text: answer.slice(emitted.length) };
            emitted = answer;
          }
        }
        if (chunk?.error) throw new AnalystTransportError(String(chunk.error).slice(0, 200));
        if (chunk?.done) break;
      }

      const parsed = parseAnalystResponse(buffer, { knownRefs });
      if (conversationId && parsed.response.answer) {
        conversations.record(conversationId, { question: asked, answer: parsed.response.answer });
      }

      yield {
        type: "result",
        ok: parsed.ok,
        degraded: parsed.degraded === true,
        response: parsed.response,
        // Only references actually retrieved are returned, so every chip the UI
        // renders resolves to something real.
        evidence: [...knownRefs.values()],
        tools: used,
        meta: {
          model: modelName,
          local: true,
          provider: "Ollama",
          toolCalls: calls,
          conversationTurns: conversationId ? conversations.turnCount(conversationId) : 0
        }
      };
    } catch (error) {
      if (signal?.aborted) {
        log("analyst.aborted", { reason: String(signal.reason || "client disconnected") });
        return;
      }
      log("analyst.error", { message: error?.message, cause: error?.cause?.message });
      yield {
        type: "error",
        state: error instanceof AnalystTransportError ? error.state : "MODEL_ERROR",
        // Product wording only. Stack traces and Ollama internals stay in logs.
        message: error instanceof AnalystTransportError
          ? error.message
          : "The Analyst could not complete this request. Faultline's deterministic findings are unaffected."
      };
    }
  }

  return { ask, model: modelName, starterQuestions };
}

/** Pull the `refs` tables out of a tool result, wherever they were nested. */
function collectRefsFrom(result) {
  const found = [];
  if (!result || typeof result !== "object") return found;
  if (Array.isArray(result.refs)) {
    for (const entry of result.refs) {
      if (entry?.ref) found.push(entry);
    }
  }
  for (const value of Object.values(result)) {
    if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.refs)) {
      for (const entry of value.refs) {
        if (entry?.ref) found.push(entry);
      }
    }
  }
  return found;
}

export { KEEP_ALIVE, MAX_QUESTION_CHARS, MAX_TOOL_CALLS };
