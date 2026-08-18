const ids = [
  "incident-list", "fault-domain", "confidence", "confidence-ring", "diagnosis-summary",
  "incident-title", "incident-id", "customer", "target", "location", "connection",
  "metrics", "evidence-list", "action-list", "path"
];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

let incidents = [];
let activeIndex = 0;

const statusFor = (value, warn, fail) => value >= fail ? "fail" : value >= warn ? "warn" : "pass";

function renderIncidentStrip() {
  els["incident-list"].innerHTML = incidents.map((incident, index) => `
    <button class="incident-chip ${index === activeIndex ? "active" : ""}" data-index="${index}">
      <span>${incident.id} · ${incident.diagnosis.faultDomainLabel}</span>
      <strong>${incident.title}</strong>
    </button>
  `).join("");

  els["incident-list"].querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      activeIndex = Number(button.dataset.index);
      render();
    });
  });
}

function render() {
  const incident = incidents[activeIndex];
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

  const path = [
    { label: "Endpoint", value: incident.connection, status: m.gatewayLoss >= 5 ? "fail" : "pass" },
    { label: "Gateway", value: `${m.gatewayLatencyMs} ms`, status: statusFor(m.gatewayLoss, 2, 5) },
    { label: "DNS", value: m.dnsResolved ? "Resolved" : "Failed", status: m.dnsResolved ? "pass" : "fail" },
    { label: "Internet path", value: `${m.upstreamLoss}% loss`, status: statusFor(m.upstreamLoss, 2, 5) },
    { label: "Target", value: m.targetReachable ? "Reachable" : "Unreachable", status: m.targetReachable ? "pass" : "fail" }
  ];
  els.path.innerHTML = path.map(node => `
    <div class="path-node ${node.status}"><small>${node.label}</small><strong>${node.value}</strong></div>
  `).join("");

  const metrics = [
    ["Gateway latency", `${m.gatewayLatencyMs} ms`, statusFor(m.gatewayLatencyMs, 25, 40)],
    ["Local packet loss", `${m.gatewayLoss}%`, statusFor(m.gatewayLoss, 2, 5)],
    ["Upstream packet loss", `${m.upstreamLoss}%`, statusFor(m.upstreamLoss, 2, 5)],
    ["Jitter", `${m.jitterMs} ms`, statusFor(m.jitterMs, 30, 50)],
    ["External probe", m.externalProbeHealthy ? "Healthy" : "Degraded", m.externalProbeHealthy ? "pass" : "fail"]
  ];
  els.metrics.innerHTML = metrics.map(([label, value, status]) => `
    <div class="metric ${status}"><span>${label}</span><strong>${value}</strong><em>${status === "pass" ? "healthy" : status === "warn" ? "elevated" : "degraded"}</em></div>
  `).join("");

  els["evidence-list"].innerHTML = result.evidence.map(item => `
    <div class="evidence-row ${item.status}">
      <span class="evidence-dot"></span>
      <strong>${item.label}</strong>
      <p>${item.detail}</p>
      <span class="evidence-value">${item.value || ""}</span>
    </div>
  `).join("");

  els["action-list"].innerHTML = result.actions.map(action => `<li>${action}</li>`).join("");
}

async function init() {
  try {
    const response = await fetch("/api/incidents");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    incidents = await response.json();
    render();
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>Faultline</h1><p>Unable to load diagnostics: ${error.message}</p></main>`;
  }
}

init();
