// Ollama transport.
//
// This is the ONLY module in Faultline that talks to an inference runtime, and
// it is deliberately narrow. Everything above it works with plain objects.
//
// Two rules are enforced here rather than trusted to callers:
//
//   1. The endpoint is loopback. The host is fixed at construction from
//      configuration that never contains user input, and is re-validated on
//      every request. There is no code path where a request body, a query
//      string or a model-generated tool argument can choose a destination.
//   2. Remote-backed models are not usable. A local Ollama can register cloud
//      models (kimi-k3:cloud, glm-5.2:cloud) that carry `remote_host` and
//      proxy inference to ollama.com. Those look local in /api/tags but would
//      send network evidence off this machine, so they are filtered out of
//      discovery and rejected at use.
//
// The transport is injectable so tests never need a running Ollama.

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

/** Loopback literals. Names are not accepted: "localhost" can be re-pointed. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

export const OLLAMA_STATE = {
  UNAVAILABLE: "OLLAMA_UNAVAILABLE",
  MODEL_NOT_INSTALLED: "MODEL_NOT_INSTALLED",
  MODEL_LOADING: "MODEL_LOADING",
  MODEL_READY: "MODEL_READY",
  MODEL_ERROR: "MODEL_ERROR"
};

export class AnalystTransportError extends Error {
  constructor(message, { state = OLLAMA_STATE.MODEL_ERROR, cause = null } = {}) {
    super(message);
    this.name = "AnalystTransportError";
    this.state = state;
    this.cause = cause;
  }
}

/**
 * Validate an endpoint before it is ever used.
 *
 * Throws rather than falling back, because silently rewriting a misconfigured
 * endpoint to loopback would hide an operator mistake that matters.
 */
export function assertLoopbackEndpoint(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new AnalystTransportError(`Analyst endpoint ${value} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AnalystTransportError(`Analyst endpoint must be http or https, got ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AnalystTransportError(
      `Analyst endpoint must be loopback (127.0.0.1 or ::1), got "${url.hostname}". ` +
      "Faultline never sends network evidence to a non-local inference host."
    );
  }
  if (url.username || url.password || url.search || (url.pathname && url.pathname !== "/")) {
    throw new AnalystTransportError("Analyst endpoint must be a bare origin with no path, query or credentials.");
  }
  return url.origin;
}

/** A model entry is local only if Ollama reports no remote backing for it. */
export function isLocalModel(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.remote_model || entry.remote_host) return false;
  const name = String(entry.name || entry.model || "");
  if (!name) return false;
  // Defence in depth: Ollama names cloud models with a ":cloud" tag. Reject the
  // tag as well as the metadata, so a metadata change cannot re-open this.
  if (/:cloud$/i.test(name)) return false;
  return true;
}

export function createOllamaClient({
  endpoint = process.env.FAULTLINE_ANALYST_ENDPOINT || DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  probeTimeoutMs = 2_500
} = {}) {
  const origin = assertLoopbackEndpoint(endpoint);
  if (typeof fetchImpl !== "function") {
    throw new AnalystTransportError("A fetch implementation is required for the Analyst transport.");
  }

  /**
   * All outbound requests funnel through here. `path` is a fixed internal
   * literal supplied by this module only - never a caller-controlled string -
   * and the origin is re-asserted so no later edit can widen the destination.
   */
  async function request(path, { method = "GET", body = null, signal = null, timeout = timeoutMs } = {}) {
    if (!path.startsWith("/api/")) throw new AnalystTransportError(`Refusing non-API Ollama path ${path}`);
    const url = `${assertLoopbackEndpoint(origin)}${path}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout);

    try {
      return await fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw new AnalystTransportError("The local model did not respond in time.", { cause: error });
      }
      // ECONNREFUSED and friends: Ollama is not listening.
      throw new AnalystTransportError("Local Ollama runtime is not reachable.", {
        state: OLLAMA_STATE.UNAVAILABLE,
        cause: error
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async function readJson(response, what) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new AnalystTransportError(`Ollama returned a malformed ${what} response.`, { cause: error });
    }
  }

  return {
    endpoint: origin,

    /** Runtime reachability + version. Never throws for the "not running" case. */
    async version({ signal } = {}) {
      try {
        const response = await request("/api/version", { signal, timeout: probeTimeoutMs });
        if (!response.ok) return { available: false, version: null };
        const payload = await readJson(response, "version");
        return { available: true, version: payload?.version || null };
      } catch {
        return { available: false, version: null };
      }
    },

    /**
     * Installed local models. Remote-backed entries are dropped here so no
     * caller can ever see, offer or select one.
     */
    async listModels({ signal } = {}) {
      const response = await request("/api/tags", { signal, timeout: probeTimeoutMs });
      if (!response.ok) {
        throw new AnalystTransportError(`Ollama model discovery failed with HTTP ${response.status}.`);
      }
      const payload = await readJson(response, "model list");
      const all = Array.isArray(payload?.models) ? payload.models : [];
      const local = all.filter(isLocalModel);
      return {
        models: local.map(entry => ({
          name: String(entry.name || entry.model),
          sizeBytes: Number(entry.size) || null,
          parameterSize: entry.details?.parameter_size || null,
          quantization: entry.details?.quantization_level || null,
          contextLength: Number(entry.details?.context_length) || null,
          capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : []
        })),
        excludedRemote: all.length - local.length
      };
    },

    /**
     * Streamed model download. Yields Ollama's raw progress records; parsing
     * into UI state lives in pull.mjs so it stays testable without a network.
     */
    async *pull(model, { signal } = {}) {
      const response = await request("/api/pull", {
        method: "POST",
        body: { model, stream: true },
        signal,
        timeout: 60 * 60_000
      });
      if (!response.ok || !response.body) {
        throw new AnalystTransportError(`Model download failed with HTTP ${response.status}.`);
      }
      yield* streamJsonLines(response.body);
    },

    /** Non-streaming chat. Used for the tool loop, where partial text is useless. */
    async chat(payload, { signal } = {}) {
      const response = await request("/api/chat", {
        method: "POST",
        body: { ...payload, stream: false },
        signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new AnalystTransportError(
          `Local model call failed with HTTP ${response.status}.`,
          { cause: detail ? new Error(detail.slice(0, 500)) : null }
        );
      }
      return readJson(response, "chat");
    },

    /** Streamed chat. Yields Ollama chat chunks. */
    async *chatStream(payload, { signal } = {}) {
      const response = await request("/api/chat", {
        method: "POST",
        body: { ...payload, stream: true },
        signal
      });
      if (!response.ok || !response.body) {
        throw new AnalystTransportError(`Local model stream failed with HTTP ${response.status}.`);
      }
      yield* streamJsonLines(response.body);
    }
  };
}

/**
 * Ollama streams newline-delimited JSON. A malformed line is skipped rather
 * than thrown: one bad frame must not destroy an otherwise usable answer.
 */
export async function *streamJsonLines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Skip an unparsable frame.
      }
    }
    // A single frame larger than this is not a real Ollama response.
    if (buffer.length > 1_000_000) buffer = "";
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      // Ignore a truncated trailing frame.
    }
  }
}

export { DEFAULT_ENDPOINT };
