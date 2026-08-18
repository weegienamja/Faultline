const ids = [
  "incident-list", "fault-domain", "confidence", "confidence-ring", "diagnosis-summary",
  "incident-title", "incident-id", "customer", "target", "location", "connection",
  "metrics", "evidence-list", "action-list", "path", "route-panel", "route-trace",
  "incident-status", "measured-at", "auth-open", "auth-dialog", "auth-form", "auth-token",
  "auth-error", "auth-cancel"
];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

let incidents = [];
let activeIndex = 0;
let adminToken = sessionStorage.getItem("faultlineAdminToken") || "";

const statusFor = (value, warn, fail) => value >= fail ? "fail" : value >= warn ? "warn" : "pass";
const displayNumber = (value, suffix = "") => Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : "Not collected";
const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function sourceLabel(incident) {
  if (incident.source === "correlated") return '<b class="source-live">2 VANTAGES</b>';
  if (incident.source === "agent") return '<b class="source-live">ENDPOINT ONLY</b>';
  return "DEMO";
}

function applyAuthState() {
  els["auth-open"].textContent = adminToken ? "Live data unlocked" : "Unlock live data";
  els["auth-open"].classList.toggle("unlocked", Boolean(adminToken));
}

function renderIncidentStrip() {
  els["incident-list"].innerHTML = incidents.map((incident, index) => `
    <button class="incident-chip ${index === activeIndex ? "active" : ""}" data-index="${index}">
      <span>${sourceLabel(incident)} · ${escapeHtml(incident.id)} · ${escapeHtml(incident.diagnosis.faultDomainLabel)}</span>
      <strong>${escapeHtml(incident.title)}</strong>
    </button>
  `).join("");

  els["incident-list"].querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      activeIndex = Number(button.dataset.index);
      render();
    });
  });
}

function renderRoute(incident) {
  const hops = incident.telemetry?.pathTrace || [];
  els["route-panel"].hidden = hops.length === 0;
  if (!hops.length) {
    els["route-trace"].innerHTML = "";
    return;
  }

  els["route-trace"].innerHTML = hops.map(hop => `
    <div class="route-hop ${hop.timedOut ? "timeout" : ""}">
      <small>HOP ${escapeHtml(hop.hop)}</small>
      <strong>${escapeHtml(hop.ip || "No response")}</strong>
      <span>${hop.averageRttMs == null ? "timeout" : `${escapeHtml(hop.averageRttMs)} ms`}</span>
    </div>
  `).join("");
}

function render() {
  const incident = incidents[activeIndex];
  if (!incident) return;
  const result = incident.diagnosis;
  const m = incident.metrics;

  renderIncidentStrip();
  els["fault-domain"].textContent = result.faultDomainLabel;
  els.confidence.textContent = `${result.confidence}%`;
  els["confidence-ring"].style.setProperty("--confidence", `${result.confidence}%`);
  els["diagnosis-summary"].textContent = result.summary;
  els["incident-title"].textContent = incident.title;
  els["incident-id"].textContent = incident.id;
  els.customer.textContent = incident.customer;
  els.target.textContent = incident.target;
  els.location.textContent = incident.location;
  els.connection.textContent = incident.connection;

  const twoVantages = incident.vantages?.remoteProbe === true || incident.source === "correlated";
  els["incident-status"].textContent = incident.source === "demo" ? "Demo incident" : twoVantages ? "2 vantage points" : "Endpoint only";
  els["incident-status"].classList.toggle("live", incident.source !== "demo");
  els["measured-at"].textContent = incident.updatedAt || incident.collectedAt
    ? new Date(incident.updatedAt || incident.collectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "demo data";

  const path = [
    { label: "Endpoint", value: incident.connection, status: m.gatewayLoss >= 5 ? "fail" : "pass" },
    { label: "Gateway", value: `${m.gatewayLatencyMs} ms`, status: statusFor(m.gatewayLoss, 2, 5) },
    { label: "DNS", value: m.dnsResolved ? "Resolved" : "Failed", status: m.dnsResolved ? "pass" : "fail" },
    { label: "Internet path", value: `${m.upstreamLoss}% loss`, status: statusFor(m.upstreamLoss, 2, 5) },
    { label: "Target", value: m.targetReachable ? "Reachable" : "Unreachable", status: m.targetReachable ? "pass" : "fail" }
  ];
  els.path.innerHTML = path.map(node => `
    <div class="path-node ${node.status}"><small>${escapeHtml(node.label)}</small><strong>${escapeHtml(node.value)}</strong></div>
  `).join("");

  const metrics = [
    ["Gateway latency", `${m.gatewayLatencyMs} ms`, statusFor(m.gatewayLatencyMs, 25, 40)],
    ["Local packet loss", `${m.gatewayLoss}%`, statusFor(m.gatewayLoss, 2, 5)],
    ["Upstream packet loss", `${m.upstreamLoss}%`, statusFor(m.upstreamLoss, 2, 5)],
    ["Jitter", `${m.jitterMs} ms`, statusFor(m.jitterMs, 30, 50)]
  ];

  if (m.dnsLookupMs != null) metrics.push(["DNS lookup", displayNumber(m.dnsLookupMs, " ms"), statusFor(m.dnsLookupMs, 300, 1000)]);
  if (m.wifiSignalPct != null) metrics.push(["Wi-Fi signal", `${m.wifiSignalPct}%`, m.wifiSignalPct < 35 ? "fail" : m.wifiSignalPct < 55 ? "warn" : "pass"]);
  if (m.targetTcpMs != null) metrics.push(["Target TCP", `${m.targetTcpMs} ms`, m.targetReachable ? "pass" : "fail"]);

  const probeValue = m.externalProbeHealthy == null
    ? "Awaiting probe"
    : `${m.externalProbeHealthy ? "Reachable" : "Unreachable"}${m.externalProbeLatencyMs != null ? ` · ${Number(m.externalProbeLatencyMs).toFixed(0)} ms` : ""}`;
  metrics.push([
    "Remote vantage",
    probeValue,
    m.externalProbeHealthy == null ? "neutral" : m.externalProbeHealthy ? "pass" : "fail"
  ]);

  els.metrics.innerHTML = metrics.map(([label, value, status]) => `
    <div class="metric ${status}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><em>${status === "pass" ? "healthy" : status === "warn" ? "elevated" : status === "neutral" ? "pending" : "degraded"}</em></div>
  `).join("");

  els["evidence-list"].innerHTML = result.evidence.map(item => `
    <div class="evidence-row ${item.status}">
      <span class="evidence-dot"></span>
      <strong>${escapeHtml(item.label)}</strong>
      <p>${escapeHtml(item.detail)}</p>
      <span class="evidence-value">${escapeHtml(item.value || "")}</span>
    </div>
  `).join("");

  els["action-list"].innerHTML = result.actions.map(action => `<li>${escapeHtml(action)}</li>`).join("");
  renderRoute(incident);
}

async function fetchJson(path, token = "") {
  const response = await fetch(path, {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loadIncidents({ initial = false } = {}) {
  const activeId = incidents[activeIndex]?.id;
  let next;

  if (adminToken) {
    try {
      next = await fetchJson("/api/incidents", adminToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      adminToken = "";
      sessionStorage.removeItem("faultlineAdminToken");
      applyAuthState();
      next = await fetchJson("/api/demo-incidents");
    }
  } else {
    next = await fetchJson("/api/demo-incidents");
  }

  const newestLive = next.find(incident => incident.source === "agent" || incident.source === "correlated");
  const isNewLive = newestLive && !incidents.some(incident => incident.id === newestLive.id);
  incidents = next;

  if (initial) activeIndex = 0;
  else if (isNewLive) activeIndex = incidents.findIndex(incident => incident.id === newestLive.id);
  else if (activeId) activeIndex = Math.max(0, incidents.findIndex(incident => incident.id === activeId));

  render();
}

els["auth-open"].addEventListener("click", () => {
  els["auth-error"].textContent = "";
  els["auth-token"].value = "";
  els["auth-dialog"].showModal();
  els["auth-token"].focus();
});

els["auth-cancel"].addEventListener("click", () => els["auth-dialog"].close());

els["auth-form"].addEventListener("submit", async event => {
  event.preventDefault();
  const candidate = els["auth-token"].value.trim();
  if (!candidate) {
    els["auth-error"].textContent = "Enter the Faultline admin token.";
    return;
  }

  els["auth-error"].textContent = "Checking credential…";
  try {
    incidents = await fetchJson("/api/incidents", candidate);
    adminToken = candidate;
    sessionStorage.setItem("faultlineAdminToken", candidate);
    activeIndex = 0;
    applyAuthState();
    render();
    els["auth-dialog"].close();
  } catch (error) {
    els["auth-error"].textContent = error.status === 401 ? "That admin token was rejected." : error.message;
  }
});

async function init() {
  try {
    applyAuthState();
    await loadIncidents({ initial: true });
    setInterval(() => loadIncidents().catch(() => {}), 4_000);
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>Faultline</h1><p>Unable to load diagnostics: ${escapeHtml(error.message)}</p></main>`;
  }
}

init();
