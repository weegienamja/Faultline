export class FaultlineClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error("FaultlineClient requires baseUrl.");
    if (!apiKey) throw new Error("FaultlineClient requires apiKey.");
    if (typeof fetchImpl !== "function") throw new Error("FaultlineClient requires fetch support.");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
    return payload;
  }

  createDiagnostic(input) { return this.request("/api/v1/diagnostics", { method: "POST", body: input }); }
  getDiagnostic(sessionId) { return this.request(`/api/v1/diagnostics/${encodeURIComponent(sessionId)}`); }
  getCase(caseId) { return this.request(`/api/v1/cases/${encodeURIComponent(caseId)}`); }
  getEvidence(caseId) { return this.request(`/api/v1/cases/${encodeURIComponent(caseId)}/evidence`); }
  createEmbedToken(input) { return this.request("/api/v1/embed-tokens", { method: "POST", body: input }); }
}
