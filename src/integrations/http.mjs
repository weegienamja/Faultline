// Shared client for public Internet-intelligence APIs.
//
// Every integration goes through here so that a slow or broken third party can
// never stall or fail a Faultline diagnostic. Each call is bounded by an
// AbortController timeout and always resolves to a status envelope rather than
// throwing into the diagnostic path.

const DEFAULT_TIMEOUT_MS = 6_000;
const USER_AGENT = "Faultline/1.5 (+https://github.com/weegienamja/Faultline-Network-Diagnostics)";

const cache = new Map();

/**
 * Number(null) and Number("") are both 0, which would turn an ABSENT value into
 * a real-looking measurement (0 ms, AS0, 0 exchanges). Always use this instead.
 */
export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function cacheKey(...parts) {
  return parts.map(part => String(part)).join("|");
}

export function readCache(key, ttlMs, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.storedAt >= ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function writeCache(key, value, now = Date.now()) {
  // Bounded so a long-running control plane cannot grow this without limit.
  if (cache.size >= 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { value, storedAt: now });
  return value;
}

export function clearIntegrationCache() {
  cache.clear();
}

/**
 * Envelope returned by every integration call.
 * status: "ok" | "unavailable" | "not-configured" | "skipped"
 */
export function ok(source, data, extra = {}) {
  return { source, status: "ok", data, error: null, ...extra };
}

export function unavailable(source, error, extra = {}) {
  return { source, status: "unavailable", data: null, error: String(error?.message || error || "unknown error"), ...extra };
}

export function notConfigured(source, reason = "No API credential configured.") {
  return { source, status: "not-configured", data: null, error: null, reason };
}

export function skipped(source, reason) {
  return { source, status: "skipped", data: null, error: null, reason };
}

/**
 * GET JSON with a hard timeout. Never throws; returns { ok, body, error, status }.
 */
export async function getJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers }
    });
    if (!response.ok) {
      return { ok: false, body: null, status: response.status, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { ok: true, body, status: response.status, error: null };
  } catch (error) {
    const message = error?.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : error?.message || String(error);
    return { ok: false, body: null, status: 0, error: message };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * POST JSON with a hard timeout. Never throws.
 */
export async function postJson(url, payload, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT, ...headers },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      return { ok: false, body, status: response.status, error: body?.error?.message || `HTTP ${response.status}` };
    }
    return { ok: true, body, status: response.status, error: null };
  } catch (error) {
    const message = error?.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : error?.message || String(error);
    return { ok: false, body: null, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps an integration call with caching and a uniform failure envelope.
 */
export async function cached(source, key, ttlMs, producer) {
  const hit = readCache(key, ttlMs);
  if (hit) return { ...hit, cached: true };
  try {
    const value = await producer();
    if (value?.status === "ok") writeCache(key, value);
    return { ...value, cached: false };
  } catch (error) {
    return unavailable(source, error);
  }
}
