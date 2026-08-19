export class FaultlineClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error("baseUrl is required.");
    if (!token) throw new Error("token is required.");
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required.");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  createDiagnostic(input) {
    return this.request("/api/v1/diagnostics", { method: "POST", body: input });
  }

  createRun(caseId, input) {
    return this.request(`/api/v1/diagnostics/${encodeURIComponent(caseId)}/runs`, { method: "POST", body: input });
  }

  getDiagnostic(caseId) {
    return this.request(`/api/v1/diagnostics/${encodeURIComponent(caseId)}`);
  }

  getEvidence(caseId, { redaction = "none" } = {}) {
    return this.request(`/api/v1/diagnostics/${encodeURIComponent(caseId)}/evidence?redaction=${encodeURIComponent(redaction)}`);
  }

  getEvents(caseId) {
    return this.request(`/api/v1/diagnostics/${encodeURIComponent(caseId)}/events`);
  }

  async waitForRun(caseId, { intervalMs = 1000, timeoutMs = 60_000, signal } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const current = await this.getDiagnostic(caseId);
      if (Number(current.status?.completedRunCount || 0) > 0) return current;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
    throw new Error(`Timed out waiting for Faultline case ${caseId}.`);
  }
}
