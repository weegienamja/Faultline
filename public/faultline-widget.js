class FaultlineDiagnosticButton extends HTMLElement {
  static observedAttributes = ["invitation-url", "label", "target"];

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const invitationUrl = this.getAttribute("invitation-url") || "";
    const label = this.getAttribute("label") || "Run network diagnostic";
    const target = this.getAttribute("target") || "_blank";
    const shadow = this.shadowRoot || this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display:inline-block; font-family:system-ui,-apple-system,Segoe UI,sans-serif; }
        a { display:inline-flex; align-items:center; gap:.55rem; border:1px solid #324158; border-radius:10px; padding:.7rem 1rem; background:#101827; color:#f7f9fc; text-decoration:none; font-weight:650; box-shadow:0 8px 22px rgba(0,0,0,.18); }
        a:hover { background:#162235; }
        a[aria-disabled="true"] { opacity:.55; pointer-events:none; }
        .dot { width:.55rem; height:.55rem; border-radius:50%; background:#6ee7b7; box-shadow:0 0 0 4px rgba(110,231,183,.12); }
      </style>
      <a ${invitationUrl ? `href="${this.escape(invitationUrl)}" target="${this.escape(target)}" rel="noopener noreferrer"` : 'href="#" aria-disabled="true"'}>
        <span class="dot"></span><span>${this.escape(label)}</span>
      </a>`;
  }

  escape(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
}

if (!customElements.get("faultline-diagnostic-button")) customElements.define("faultline-diagnostic-button", FaultlineDiagnosticButton);
