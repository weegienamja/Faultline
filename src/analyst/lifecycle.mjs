// Analyst runtime lifecycle.
//
// Resolves the five states the UI is allowed to render, and parses model
// download progress. Both are pure functions over transport output so they can
// be tested without Ollama, a GPU or a network.
//
// The states are deliberately coarse. The drawer needs to answer "can I ask a
// question yet, and if not what do I do about it" - not to expose Ollama's
// internal vocabulary.

import { AnalystTransportError, OLLAMA_STATE } from "./ollama.mjs";

/** Model names are configuration, not free text. */
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/i;

export const DEFAULT_MODEL = "qwen3:8b";

/**
 * Reject anything that is not a plain model reference.
 *
 * This is the choke point that stops a configured or requested model from
 * being a path, a URL or a cloud tag. `:cloud` is refused by name here as well
 * as by metadata in the transport.
 */
export function assertModelName(value, { field = "model" } = {}) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 128 || !MODEL_NAME.test(name)) {
    const error = new Error(`Invalid Analyst ${field} name.`);
    error.statusCode = 400;
    throw error;
  }
  if (/:cloud$/i.test(name)) {
    const error = new Error("Cloud-hosted models are not permitted. The Faultline Analyst runs locally only.");
    error.statusCode = 400;
    throw error;
  }
  return name;
}

/**
 * Ask the runtime what state the Analyst is in.
 *
 * Never throws for the ordinary "nothing is installed" paths: an unavailable
 * Analyst is a normal condition, not an error, and Faultline's deterministic
 * features are unaffected by it.
 */
export async function resolveStatus(client, { model = DEFAULT_MODEL, signal = null } = {}) {
  const name = assertModelName(model);
  const base = {
    product: "Faultline Analyst",
    model: name,
    endpoint: client.endpoint,
    local: true,
    provider: "Ollama"
  };

  const version = await client.version({ signal });
  if (!version.available) {
    return {
      ...base,
      state: OLLAMA_STATE.UNAVAILABLE,
      ready: false,
      runtimeVersion: null,
      installedModels: [],
      detail: "The local Ollama runtime is not running or not installed.",
      remedy: "Start Ollama, then reopen the Analyst."
    };
  }

  let discovery;
  try {
    discovery = await client.listModels({ signal });
  } catch (error) {
    return {
      ...base,
      state: OLLAMA_STATE.MODEL_ERROR,
      ready: false,
      runtimeVersion: version.version,
      installedModels: [],
      detail: "Ollama is running but model discovery failed.",
      remedy: "Check the Ollama service logs.",
      error: error instanceof AnalystTransportError ? error.message : "Model discovery failed."
    };
  }

  const installed = discovery.models.find(entry => entry.name === name)
    // `qwen3:8b` and a bare `qwen3` both address the same default tag.
    || discovery.models.find(entry => entry.name === `${name}:latest`);

  if (!installed) {
    return {
      ...base,
      state: OLLAMA_STATE.MODEL_NOT_INSTALLED,
      ready: false,
      runtimeVersion: version.version,
      installedModels: discovery.models,
      excludedRemoteModels: discovery.excludedRemote,
      detail: `${name} is not installed in the local Ollama runtime.`,
      remedy: `Install ${name} from this screen. Nothing is downloaded until you ask for it.`
    };
  }

  // Tool calling is not optional for this design: without it the Analyst cannot
  // retrieve evidence and would be reduced to guessing from the page context.
  const capabilities = installed.capabilities || [];
  const supportsTools = capabilities.length === 0 || capabilities.includes("tools");

  return {
    ...base,
    state: OLLAMA_STATE.MODEL_READY,
    ready: true,
    runtimeVersion: version.version,
    installedModels: discovery.models,
    excludedRemoteModels: discovery.excludedRemote,
    supportsTools,
    modelDetail: {
      sizeBytes: installed.sizeBytes,
      parameterSize: installed.parameterSize,
      quantization: installed.quantization,
      contextLength: installed.contextLength,
      capabilities
    },
    detail: supportsTools
      ? "Ready. Evidence is retrieved through read-only Faultline tools."
      : "The installed model does not advertise tool calling, so evidence retrieval may be limited.",
    remedy: null
  };
}

/**
 * Normalise one Ollama pull frame into UI progress.
 *
 * Ollama emits a `status` string plus optional `completed`/`total` byte
 * counters, and repeats the same status across many frames. Percentages are
 * clamped because a truncated or out-of-order frame must not render a 4000%
 * progress bar.
 */
export function parsePullProgress(frame) {
  if (!frame || typeof frame !== "object") return null;

  if (frame.error) {
    return { phase: "error", status: String(frame.error).slice(0, 300), error: true, done: true };
  }

  const status = String(frame.status || "").trim();
  const total = Number(frame.total);
  const completed = Number(frame.completed);
  const hasBytes = Number.isFinite(total) && total > 0 && Number.isFinite(completed) && completed >= 0;
  const percent = hasBytes ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : null;

  // Ollama's terminal frame for a completed pull.
  const done = /^success$/i.test(status);

  return {
    phase: done ? "done" : phaseOf(status),
    status: status || "working",
    label: labelFor(status),
    completedBytes: hasBytes ? completed : null,
    totalBytes: hasBytes ? total : null,
    percent,
    digest: typeof frame.digest === "string" ? frame.digest.slice(0, 80) : null,
    done,
    error: false
  };
}

function phaseOf(status) {
  const value = status.toLowerCase();
  if (value.startsWith("pulling manifest")) return "manifest";
  if (value.startsWith("pulling")) return "download";
  if (value.startsWith("verifying")) return "verify";
  if (value.startsWith("writing") || value.startsWith("removing")) return "finalise";
  return "working";
}

/** Product-facing wording. Ollama's own strings leak digests into the UI. */
function labelFor(status) {
  switch (phaseOf(status)) {
    case "manifest": return "Resolving model manifest";
    case "download": return "Downloading model weights";
    case "verify": return "Verifying download";
    case "finalise": return "Finalising installation";
    case "done": return "Installed";
    default: return status || "Working";
  }
}

export { OLLAMA_STATE };
