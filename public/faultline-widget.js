class FaultlineDiagnosticButton extends HTMLElement {
  connectedCallback() {
    const endpoint = this.getAttribute("endpoint") || "/api/embed/diagnostics";
    const token = this.getAttribute("token") || "";
    const label = this.getAttribute("label") || "Run connection diagnostic";
    this.innerHTML = `<button type="button" style="font:inherit;padding:.7em 1em;border-radius:8px;border:1px solid #3b5b52;background:#15372f;color:#dffaf1;cursor:pointer">${label}</button><span style="margin-left:.7em;font:12px system-ui;color:#667"> </span>`;
    const button = this.querySelector("button");
    const status = this.querySelector("span");
    button.addEventListener("click", async () => {
      if (!token) { status.textContent = "Missing one-use embed token."; return; }
      button.disabled = true; status.textContent = "Creating diagnostic…";
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        status.textContent = "Diagnostic ready.";
        if (payload.invitation) window.open(payload.invitation, "_blank", "noopener");
        this.dispatchEvent(new CustomEvent("faultline-diagnostic-created", { detail: payload, bubbles: true }));
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
}
if (!customElements.get("faultline-diagnostic-button")) customElements.define("faultline-diagnostic-button", FaultlineDiagnosticButton);
