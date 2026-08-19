// Read-only tool gateway.
//
// The model retrieves evidence exclusively through the functions declared here.
// Everything a tool call touches is mediated:
//
//   * The name must be one of the registered tools. An unknown name is a
//     refusal, never a lookup on some object.
//   * Arguments are parsed by that tool's own validator into a fresh object.
//     Model-supplied values never become paths, hosts, URLs, commands or keys.
//   * The execution context exposes read accessors only. There is no write
//     method to reach, so "the model deleted a case" is not a bug that can
//     exist - the capability is absent, not merely unused.
//
// Tool results are compact projections (see evidence.mjs), not internal state.

import { projectBisectRun, projectCase, projectLiveDiagnostic } from "./evidence.mjs";
import { EVIDENCE_KIND } from "./registry.mjs";
import { lookupTerm } from "./docs.mjs";

export class ToolError extends Error {
  constructor(message, { code = "TOOL_ERROR" } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

// --- argument validators ----------------------------------------------------
//
// Small and explicit rather than a schema library: every tool argument in this
// gateway is a short identifier or a query string, and a bespoke check is
// easier to audit than a generic validator's configuration.

const ID = /^[A-Za-z0-9_.:-]{1,120}$/;

function optionalId(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID.test(value)) {
    throw new ToolError(`Argument "${key}" must be a short identifier.`, { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function requiredId(args, key) {
  const value = optionalId(args, key);
  if (!value) throw new ToolError(`Argument "${key}" is required.`, { code: "INVALID_ARGUMENT" });
  return value;
}

function queryText(args, key, { max = 200 } = {}) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError(`Argument "${key}" must be a non-empty string.`, { code: "INVALID_ARGUMENT" });
  }
  if (value.length > max) {
    throw new ToolError(`Argument "${key}" is too long.`, { code: "INVALID_ARGUMENT" });
  }
  return value.trim();
}

function boundedCount(args, key, fallback, max) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new ToolError(`Argument "${key}" must be a positive integer.`, { code: "INVALID_ARGUMENT" });
  }
  return Math.min(numeric, max);
}

const NOT_AVAILABLE = reason => ({ available: false, reason });

/**
 * The tool table.
 *
 * Each entry exists because a real user question needs it; `why` is kept next
 * to the code so the read-only surface cannot quietly grow without a stated
 * reason.
 */
export const TOOLS = [
  {
    name: "get_current_view",
    why: "Answers 'what is this screen telling me' without the model guessing which surface the user is on.",
    description: "Return the Faultline screen the user is currently viewing and its immediate context.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: (_args, ctx) => ({
      view: ctx.view.view,
      viewLabel: ctx.view.label ?? null,
      target: ctx.view.target ?? null,
      activeRunId: ctx.view.activeRunId ?? null,
      activeCaseId: ctx.view.activeCaseId ?? null
    })
  },

  {
    name: "get_current_target",
    why: "The target is the subject of most questions and is otherwise scattered across three different records.",
    description: "Return the network target currently under investigation.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: (_args, ctx) => {
      const bisect = ctx.registry.latest(EVIDENCE_KIND.BISECT);
      const live = ctx.registry.latest(EVIDENCE_KIND.LIVE);
      const target = ctx.view.target || bisect?.target?.host || live?.target?.host || null;
      if (!target) return NOT_AVAILABLE("No target has been measured in this session.");
      return {
        available: true,
        target,
        source: ctx.view.target ? "current_view" : bisect ? "latest_bisect_run" : "latest_live_diagnostic",
        resolvedAddress: live?.target?.resolvedAddress ?? null,
        resolvedFamily: live?.target?.resolvedFamily ?? null
      };
    }
  },

  {
    name: "get_current_diagnosis",
    why: "The authoritative deterministic conclusion. Without it the model would reason from raw stages and invent a verdict.",
    description: "Return the authoritative deterministic Faultline fault-domain diagnosis for the latest live diagnostic.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: (_args, ctx) => {
      const run = ctx.registry.latest(EVIDENCE_KIND.LIVE);
      if (!run) return NOT_AVAILABLE("No live diagnostic has been run in this session.");
      const projected = projectLiveDiagnostic(run);
      return {
        available: true,
        evidenceClass: "deterministic",
        runId: projected.runId,
        target: projected.target,
        diagnosis: projected.deterministic,
        stages: projected.observed.stages,
        refs: projected.refs.filter(ref => ref.kind === "diagnosis" || ref.kind === "stage")
      };
    }
  },

  {
    name: "get_live_diagnostic",
    why: "Stage-level DNS/TCP/TLS/HTTP evidence answers 'what actually failed' and 'what was never measured'.",
    description: "Return the full compact evidence for a live diagnostic run, including per-stage results and local network state.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", description: "Optional run id. Omit for the most recent run." } },
      required: []
    },
    parse: args => ({ runId: optionalId(args, "runId") }),
    run: ({ runId }, ctx) => {
      const run = runId ? ctx.registry.get(EVIDENCE_KIND.LIVE, runId) : ctx.registry.latest(EVIDENCE_KIND.LIVE);
      if (!run) return NOT_AVAILABLE(runId ? `No live diagnostic ${runId} is retained.` : "No live diagnostic has been run in this session.");
      return { available: true, ...projectLiveDiagnostic(run) };
    }
  },

  {
    name: "get_latest_bisect_run",
    why: "The primary Isolate artefact; 'explain this result' is the single most common Network Bisect question.",
    description: "Return the most recent Network Bisect isolation run: baseline, executed experiments, confirmation and deterministic verdict.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: (_args, ctx) => {
      const report = ctx.registry.latest(EVIDENCE_KIND.BISECT);
      if (!report) return NOT_AVAILABLE("No Network Bisect run has been performed in this session.");
      return { available: true, ...projectBisectRun(report) };
    }
  },

  {
    name: "get_bisect_run",
    why: "Lets a question about an earlier run be answered without re-running measurements.",
    description: "Return a specific retained Network Bisect run by id.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", description: "The bisect run id." } },
      required: ["runId"]
    },
    parse: args => ({ runId: requiredId(args, "runId") }),
    run: ({ runId }, ctx) => {
      const report = ctx.registry.get(EVIDENCE_KIND.BISECT, runId);
      if (!report) return NOT_AVAILABLE(`No Network Bisect run ${runId} is retained in memory.`);
      return { available: true, ...projectBisectRun(report) };
    }
  },

  {
    name: "get_bisect_experiment_path",
    why: "Answers 'why did Bisect test IPv4 first' - the selection reasoning is the part users find opaque.",
    description: "Return the ordered experiment path of a Network Bisect run with the engine's reason for choosing each experiment, plus what was skipped and why.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", description: "Optional run id. Omit for the most recent run." } },
      required: []
    },
    parse: args => ({ runId: optionalId(args, "runId") }),
    run: ({ runId }, ctx) => {
      const report = runId ? ctx.registry.get(EVIDENCE_KIND.BISECT, runId) : ctx.registry.latest(EVIDENCE_KIND.BISECT);
      if (!report) return NOT_AVAILABLE("No Network Bisect run is retained.");
      const projected = projectBisectRun(report);
      return {
        available: true,
        runId: projected.runId,
        baseline: projected.baseline,
        experiments: projected.experiments,
        skipped: projected.skipped,
        axesUnavailable: projected.axesUnavailable,
        stoppingReason: projected.verdict?.stoppingReason ?? null,
        note: "Skipped and unavailable axes were not tested. They are not failures.",
        refs: projected.refs
      };
    }
  },

  {
    name: "get_bisect_hypotheses",
    why: "Hypothesis states are how Bisect records what the evidence ruled out - the basis for 'what ruled out DNS'.",
    description: "Return the competing explanations Network Bisect tracked and the state the evidence left each one in.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", description: "Optional run id. Omit for the most recent run." } },
      required: []
    },
    parse: args => ({ runId: optionalId(args, "runId") }),
    run: ({ runId }, ctx) => {
      const report = runId ? ctx.registry.get(EVIDENCE_KIND.BISECT, runId) : ctx.registry.latest(EVIDENCE_KIND.BISECT);
      if (!report) return NOT_AVAILABLE("No Network Bisect run is retained.");
      const projected = projectBisectRun(report);
      return {
        available: true,
        runId: projected.runId,
        hypotheses: projected.hypotheses,
        legend: {
          SUPPORTED: "An observation matched a distinctive prediction.",
          STILL_POSSIBLE: "Not yet distinguished either way.",
          WEAKENED: "Fits poorly but is not excluded.",
          CONTRADICTED: "Incompatible with an observation.",
          NOT_TESTABLE: "This machine or target cannot test it."
        }
      };
    }
  },

  {
    name: "get_topology",
    why: "Separates measured hops from inferred local shape, which is the observed-versus-inferred question.",
    description: "Return the inferred local topology and the measured network path, keeping observed and inferred separate.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: (_args, ctx) => {
      const run = ctx.registry.latest(EVIDENCE_KIND.LIVE);
      if (!run) return NOT_AVAILABLE("No live diagnostic has been run, so no path has been measured.");
      const projected = projectLiveDiagnostic(run);
      return {
        available: true,
        observedPath: projected.path,
        observedPathNote: "Measured hops. Absent hops mean no response, not necessarily a fault.",
        inferred: projected.inferred,
        inferredNote: "Inferred topology is derived from local state, not directly measured.",
        traceroute: projected.observed.traceroute,
        refs: projected.refs.filter(ref => ref.kind === "hop")
      };
    }
  },

  {
    name: "get_recent_cases",
    why: "Cases are the Preserve surface; the drawer needs a list before it can summarise one.",
    description: "List recent Faultline support cases with status and severity.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many cases to return (max 10)." } },
      required: []
    },
    parse: args => ({ limit: boundedCount(args, "limit", 5, 10) }),
    run: async ({ limit }, ctx) => {
      const cases = await ctx.store.listCases();
      if (!cases.length) return NOT_AVAILABLE("No support cases exist yet.");
      return {
        available: true,
        count: cases.length,
        cases: cases.slice(0, limit).map(record => ({
          ref: `CASE-${record.id}`,
          id: record.id,
          title: record.title ?? null,
          status: record.status ?? null,
          severity: record.severity ?? null,
          updatedAt: record.updatedAt ?? record.createdAt ?? null
        }))
      };
    }
  },

  {
    name: "get_case",
    why: "Answers 'summarise this incident' and 'what evidence supports the conclusion' for a specific case.",
    description: "Return one support case with its notes and evidence timeline.",
    parameters: {
      type: "object",
      properties: { caseId: { type: "string", description: "The case id." } },
      required: ["caseId"]
    },
    parse: args => ({ caseId: requiredId(args, "caseId") }),
    run: async ({ caseId }, ctx) => {
      const record = await ctx.store.getCase(caseId);
      if (!record) return NOT_AVAILABLE(`No case ${caseId} exists.`);
      return { available: true, ...projectCase(record) };
    }
  },

  {
    name: "get_probe_fleet",
    why: "'Why did Faultline skip this vantage' is usually answered by probe health, not by the measurement.",
    description: "Return registered probe fleet health and scope.",
    parameters: { type: "object", properties: {}, required: [] },
    parse: () => ({}),
    run: async (_args, ctx) => {
      const probes = await ctx.store.listProbes();
      if (!probes.length) return NOT_AVAILABLE("No probes are registered.");
      return {
        available: true,
        count: probes.length,
        probes: probes.slice(0, 20).map(probe => ({
          id: probe.id,
          name: probe.name ?? null,
          scope: probe.scope ?? "public",
          health: probe.health ?? null,
          lastSeenAt: probe.lastSeenAt ?? null,
          enabled: probe.enabled !== false,
          draining: Boolean(probe.draining),
          maintenance: Boolean(probe.maintenance)
        }))
      };
    }
  },

  {
    name: "search_faultline_docs",
    why: "Makes the repository's own documentation the authority on Faultline behaviour instead of the model's priors.",
    description: "Search Faultline's own documentation for how a feature or behaviour works. Use this for questions about Faultline itself.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, in a few words." },
        limit: { type: "integer", description: "How many sections to return (max 6)." }
      },
      required: ["query"]
    },
    parse: args => ({ query: queryText(args, "query"), limit: boundedCount(args, "limit", 3, 6) }),
    run: ({ query, limit }, ctx) => {
      const results = ctx.docs ? ctx.docs.search(query, { limit }) : [];
      if (!results.length) return NOT_AVAILABLE(`Faultline's documentation has no section matching "${query}".`);
      return {
        available: true,
        query,
        results,
        note: "Excerpts from this repository's documentation. Treat as authoritative for Faultline behaviour."
      };
    }
  },

  {
    name: "get_faultline_term",
    why: "State names carry precise meaning; INAPPLICABLE read as FAIL is the exact error this feature prevents.",
    description: "Return the precise Faultline definition of an engine state or classification term such as TARGET_PROPERTY, INAPPLICABLE or FAILURE_DISCRIMINATOR.",
    parameters: {
      type: "object",
      properties: { term: { type: "string", description: "The term to define." } },
      required: ["term"]
    },
    parse: args => ({ term: queryText(args, "term", { max: 80 }) }),
    run: ({ term }, ctx) => {
      const found = lookupTerm(term);
      if (found) return { available: true, ...found };
      const docs = ctx.docs ? ctx.docs.search(term, { limit: 2 }) : [];
      if (docs.length) return { available: true, term, definition: null, documentation: docs };
      return NOT_AVAILABLE(`"${term}" is not a Faultline engine term and does not appear in the documentation.`);
    }
  }
];

const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

/** The declaration list handed to Ollama. */
export function toolDeclarations() {
  return TOOLS.map(tool => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }));
}

export function toolNames() {
  return TOOLS.map(tool => tool.name);
}

/**
 * A store facade exposing read accessors only.
 *
 * Passing the real store would mean a write method is one typo away from being
 * reachable by model-directed code. This makes the capability absent.
 */
export function readOnlyStore(store) {
  return {
    listCases: () => store.listCases(),
    getCase: id => store.getCase(id),
    listProbes: () => store.listProbes(),
    getProbe: id => store.getProbe(id),
    listSessions: () => store.listSessions(),
    listRuns: limit => store.listRuns(limit),
    getRun: id => store.getRun(id)
  };
}

/**
 * Execute one model-requested tool call.
 *
 * Model output is untrusted input. Failures are returned as structured refusals
 * so the loop can hand the model a correction instead of aborting the answer.
 */
export async function executeTool(name, rawArgs, context) {
  const toolName = typeof name === "string" ? name : "";
  const tool = BY_NAME.get(toolName);
  if (!tool) {
    return {
      ok: false,
      error: "UNKNOWN_TOOL",
      message: `No Faultline tool named "${String(toolName).slice(0, 60)}" exists.`,
      availableTools: toolNames()
    };
  }

  let args;
  try {
    // Ollama returns an object, but a stringified object is a known variation.
    const candidate = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ToolError("Tool arguments must be an object.", { code: "INVALID_ARGUMENT" });
    }
    args = tool.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ToolError ? error.code : "INVALID_ARGUMENT",
      message: error instanceof ToolError ? error.message : "Tool arguments could not be parsed.",
      tool: toolName
    };
  }

  try {
    const result = await tool.run(args, context);
    return { ok: true, tool: toolName, result };
  } catch (error) {
    // A tool fault must degrade the answer, not crash the request.
    return {
      ok: false,
      error: "TOOL_EXECUTION_FAILED",
      message: `The ${toolName} tool could not complete.`,
      tool: toolName,
      detail: String(error?.message || "").slice(0, 200)
    };
  }
}
