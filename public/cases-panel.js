import { words } from "./shell.js";

/** Why this surface is unavailable, phrased for the runtime it is in. */
function lockedMessage(what) {
  return words.lockedBody(what);
}

const lowerGrid = document.querySelector('[data-mount="cases"]') || document.querySelector(".lower-grid");
const CASE_TOKEN_KEY = "faultlineAdminToken";
let cases = [];
let activeCaseId = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function token() {
  return sessionStorage.getItem(CASE_TOKEN_KEY) || "";
}

async function request(path, options = {}) {
  if (!token()) throw new Error(lockedMessage("The case workspace"));
  const response = await fetch(path, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token()}`,
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
  return payload;
}

function createDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.id = "case-dialog";
  dialog.innerHTML = `<form class="auth-form" id="case-form"><div><span class="section-label">CASE WORKSPACE</span><h2 class="fl-panel-title">Create support case</h2></div><div class="case-form-grid"><label class="wide">Title<input id="case-title" required placeholder="Intermittent voice degradation"></label><label>Customer<input id="case-customer" placeholder="Northstar Design"></label><label>Affected service<input id="case-service" placeholder="Voice platform"></label><label>Severity<select id="case-severity"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></label></div><p class="auth-error" id="case-error"></p><div class="auth-actions"><button class="secondary-button" type="button" id="case-cancel">Cancel</button><button class="primary-button" type="submit">Create case</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector("#case-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("#case-form").addEventListener("submit", async event => {
    event.preventDefault();
    const errorBox = dialog.querySelector("#case-error");
    try {
      const created = await request("/api/cases", { method: "POST", body: {
        title: dialog.querySelector("#case-title").value,
        customer: dialog.querySelector("#case-customer").value,
        affectedService: dialog.querySelector("#case-service").value,
        severity: dialog.querySelector("#case-severity").value
      }});
      activeCaseId = created.id;
      dialog.close();
      dialog.querySelector("#case-form").reset();
      await refresh();
    } catch (error) { errorBox.textContent = error.message; }
  });
  return dialog;
}

function createDiagnosticDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.id = "case-diagnostic-dialog";
  dialog.innerHTML = `<form class="auth-form" id="case-diagnostic-form"><div><span class="section-label">CASE DIAGNOSTIC</span><h2 class="fl-panel-title">Add diagnostic run</h2></div><label>Target<input id="case-target" required placeholder="https://service.example/health"></label><label>Connectivity Contract<select id="case-contract"><option value="">Generic checks only</option></select></label><p class="auth-error" id="case-diagnostic-error"></p><div class="case-result" id="case-invitation-result" hidden></div><div class="auth-actions"><button class="secondary-button" type="button" id="case-diagnostic-cancel">Close</button><button class="primary-button" type="submit">Create diagnostic</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector("#case-diagnostic-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("#case-diagnostic-form").addEventListener("submit", async event => {
    event.preventDefault();
    const errorBox = dialog.querySelector("#case-diagnostic-error");
    try {
      const contractId = dialog.querySelector("#case-contract").value;
      const contracts = await fetch("/contracts.json", { cache: "no-store" }).then(r => r.json());
      const connectivityContract = contracts.find(item => item.id === contractId) || undefined;
      const result = await request(`/api/cases/${encodeURIComponent(activeCaseId)}/diagnostics`, { method: "POST", body: {
        target: dialog.querySelector("#case-target").value,
        connectivityContract,
        probeSelector: { scope: "public" },
        ttlMinutes: 60
      }});
      const invitation = result.invitation?.path ? `${location.origin}${result.invitation.path}` : "Direct diagnostic created";
      const output = dialog.querySelector("#case-invitation-result");
      output.hidden = false;
      output.innerHTML = `<strong>${escapeHtml(result.session.id)}</strong><br><span>${escapeHtml(invitation)}</span><br><button class="secondary-button" type="button" id="copy-case-invite">Copy invitation</button>`;
      output.querySelector("#copy-case-invite")?.addEventListener("click", async () => navigator.clipboard.writeText(invitation));
      errorBox.textContent = "";
      await refresh();
    } catch (error) { errorBox.textContent = error.message; }
  });
  return dialog;
}

const createCaseDialog = createDialog();
const diagnosticDialog = createDiagnosticDialog();

const panel = document.createElement("section");
panel.className = "panel cases-panel";
panel.id = "case-workspaces";
panel.innerHTML = `<div class="cases-head"><div><span class="section-label">SUPPORT CASES</span><h2 class="fl-panel-title fl-mt-1">Cases &amp; evidence packages</h2></div><div class="cases-actions"><button class="secondary-button" id="case-refresh">Refresh</button><button class="primary-button" id="case-new">New case</button></div></div><p class="cases-muted" id="case-summary"></p><div class="case-layout"><div class="case-list" id="case-list"></div><article class="case-detail" id="case-detail"><p class="cases-muted">Select a case to inspect its diagnostics and evidence timeline.</p></article></div>`;
if (lowerGrid?.dataset?.mount) lowerGrid.appendChild(panel);
else lowerGrid?.parentNode?.insertBefore(panel, lowerGrid);

const summary = panel.querySelector("#case-summary");
const list = panel.querySelector("#case-list");
const detail = panel.querySelector("#case-detail");
panel.querySelector("#case-new").addEventListener("click", () => {
  if (!token()) return document.getElementById("auth-open")?.click();
  createCaseDialog.showModal();
});
panel.querySelector("#case-refresh").addEventListener("click", refresh);

async function fetchAuthedBlob(path, type) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token()}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Export failed with HTTP ${response.status}.`);
  const blob = await response.blob();
  const url = URL.createObjectURL(new Blob([blob], { type }));
  return url;
}

async function renderDetail() {
  const current = cases.find(item => item.id === activeCaseId);
  if (!current) {
    detail.innerHTML = '<p class="cases-muted">Select a case to inspect its diagnostics and evidence timeline.</p>';
    return;
  }
  detail.innerHTML = `<span class="section-label">${escapeHtml(current.id)}</span><h2 class="fl-panel-title fl-mt-1">${escapeHtml(current.title)}</h2><p class="cases-muted">${escapeHtml(current.customer)} · ${escapeHtml(current.affectedService)}</p><div class="case-meta"><span class="case-pill">${escapeHtml(current.status)}</span><span class="case-pill">${escapeHtml(current.severity)}</span><span class="case-pill">${current.diagnosticCount} diagnostics</span><span class="case-pill">${current.completedDiagnosticCount} with evidence</span></div><div class="cases-actions"><button class="primary-button" id="case-add-diagnostic">Add diagnostic</button><button class="secondary-button" id="case-json">Evidence JSON</button><button class="secondary-button" id="case-report">Print report</button></div><ol class="case-timeline">${(current.timeline || []).slice(-12).reverse().map(event => `<li><strong>${escapeHtml(event.type)}</strong> · ${escapeHtml(event.summary)} <em>${escapeHtml(event.evidenceKind)}</em></li>`).join("") || "<li>No timeline events.</li>"}</ol>`;
  detail.querySelector("#case-add-diagnostic").addEventListener("click", async () => {
    const select = diagnosticDialog.querySelector("#case-contract");
    const contracts = await fetch("/contracts.json", { cache: "no-store" }).then(r => r.json()).catch(() => []);
    select.innerHTML = '<option value="">Generic checks only</option>' + contracts.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
    diagnosticDialog.querySelector("#case-invitation-result").hidden = true;
    diagnosticDialog.showModal();
  });
  detail.querySelector("#case-json").addEventListener("click", async () => {
    const url = await fetchAuthedBlob(`/api/cases/${encodeURIComponent(current.id)}/evidence?redaction=network-identifiers`, "application/json");
    const a = document.createElement("a"); a.href = url; a.download = `${current.id}-evidence.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  detail.querySelector("#case-report").addEventListener("click", async () => {
    const url = await fetchAuthedBlob(`/api/cases/${encodeURIComponent(current.id)}/report?redaction=network-identifiers`, "text/html");
    window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

function renderList() {
  summary.textContent = token() ? `${cases.length} support case${cases.length === 1 ? "" : "s"}. Evidence exports redact local network identifiers by default in the dashboard.` : lockedMessage("The support case workspace");
  list.innerHTML = cases.length ? cases.map(item => `<button class="case-card ${item.id === activeCaseId ? "active" : ""}" data-case-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.customer)} · ${escapeHtml(item.status)} · ${item.diagnosticCount} diagnostics</small></button>`).join("") : '<p class="cases-muted">No support cases yet.</p>';
  list.querySelectorAll("[data-case-id]").forEach(button => button.addEventListener("click", async () => { activeCaseId = button.dataset.caseId; renderList(); await renderDetail(); }));
}

async function refresh() {
  if (!token()) { cases = []; renderList(); await renderDetail(); return; }
  try {
    cases = await request("/api/cases");
    if (!activeCaseId && cases.length) activeCaseId = cases[0].id;
    if (activeCaseId && !cases.some(item => item.id === activeCaseId)) activeCaseId = cases[0]?.id || null;
    renderList(); await renderDetail();
  } catch (error) { summary.textContent = `Case workspaces unavailable: ${error.message}`; }
}

window.addEventListener("faultline-auth-changed", refresh);
setInterval(() => { if (token()) refresh(); }, 30_000);
refresh();
