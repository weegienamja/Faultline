// Surfaces that have structure but no dedicated panel module yet:
// the Overview summary row, Flight Recorder, Change Assurance, Environment
// and Settings.
//
// Where a capability is not implemented, this file renders a designed empty
// state that says so. It does not render placeholder charts. A dashboard that
// invents data to look complete is the single fastest way to lose an
// operator's trust, and Faultline's whole argument is that every value on
// screen is traceable to a measurement.

import { mount, panel, tile, state, badge, source, disclose, auth, goTo, currentView, escapeHtml, runtime, words } from "./shell.js";

// ---------------------------------------------------------------------------
// Rail credential indicator
// ---------------------------------------------------------------------------

function paintAuthIndicator() {
  const dot = document.getElementById("rail-auth-dot");
  // Two spans exist so the FIRST paint is already right for the runtime; only
  // the one the CSS gate leaves visible needs updating afterwards.
  const text = document.getElementById(runtime.isPublicDemo ? "rail-auth-text-demo" : "rail-auth-text");
  if (!dot || !text) return;
  dot.dataset.status = auth.unlocked ? "ok" : "idle";
  text.textContent = auth.unlocked ? words.railUnlocked : words.railLocked;
}
window.addEventListener("faultline-auth-changed", paintAuthIndicator);
paintAuthIndicator();

// ---------------------------------------------------------------------------
// Overview summary row
// ---------------------------------------------------------------------------
// Four tiles, chosen to answer the questions an operator opens the product
// with: is something wrong, where, how sure are we, and how fresh is this.

function severityOf(incident) {
  const m = incident?.metrics || {};
  if (m.targetReachable === false || m.dnsResolved === false) return "crit";
  if ((m.upstreamLoss ?? 0) >= 5 || (m.gatewayLoss ?? 0) >= 5) return "crit";
  if ((m.upstreamLoss ?? 0) >= 2 || (m.gatewayLoss ?? 0) >= 2) return "warn";
  return "ok";
}

function renderOverviewTiles(detail) {
  const host = document.getElementById("overview-tiles");
  if (!host) return;
  const { incident, incidents = [], probes = [] } = detail || {};
  // No incident means the Overview is showing its empty state; the tiles clear
  // rather than keeping the last incident's figures on screen.
  if (!incident) {
    host.innerHTML = "";
    return;
  }

  const m = incident.metrics || {};
  const severity = severityOf(incident);
  const online = probes.filter(p => p.health === "online").length;

  // The aggregate across everything collected, not just the failing ones. It
  // previously counted only crit and called anything else "all healthy", so a
  // set of degraded diagnostics with nothing outright failing reported itself
  // as healthy.
  const counts = { crit: 0, warn: 0, ok: 0 };
  for (const item of incidents) counts[severityOf(item)] += 1;
  const collected = [
    counts.crit ? `${counts.crit} failing` : null,
    counts.warn ? `${counts.warn} degraded` : null
  ].filter(Boolean).join(" · ") || "all healthy";

  host.innerHTML = [
    tile({
      label: "Service state",
      value: severity === "ok" ? "Healthy" : severity === "warn" ? "Degraded" : "Failing",
      sub: `<span class="fl-dot" data-status="${severity}"></span> ${incident.target || "no target"}`,
      status: severity
    }),
    tile({
      label: "Fault domain",
      value: incident.diagnosis?.faultDomainLabel || "Unknown",
      sub: `${incident.diagnosis?.confidence ?? "--"}% confidence`,
      status: severity === "ok" ? "idle" : severity
    }),
    tile({
      label: "Upstream loss",
      value: Number.isFinite(Number(m.upstreamLoss)) ? String(m.upstreamLoss) : "—",
      unit: "%",
      sub: `Gateway ${Number.isFinite(Number(m.gatewayLatencyMs)) ? `${m.gatewayLatencyMs} ms` : "—"}`,
      status: (m.upstreamLoss ?? 0) >= 5 ? "crit" : (m.upstreamLoss ?? 0) >= 2 ? "warn" : "ok"
    }),
    tile({
      label: "Vantage points",
      value: String(probes.length ? online : (incident.vantages?.remoteProbe ? 2 : 1)),
      sub: probes.length ? `${probes.length} registered` : "endpoint only",
      status: probes.length && online === 0 ? "crit" : "idle"
    }),
    tile({
      label: "Collected diagnostics",
      value: String(incidents.length),
      sub: collected,
      status: counts.crit ? "crit" : counts.warn ? "warn" : "ok"
    })
  ].join("");
}

window.addEventListener("faultline-incident", event => renderOverviewTiles(event.detail));

// ---------------------------------------------------------------------------
// Flight Recorder
// ---------------------------------------------------------------------------
// Not implemented. The roadmap theme is "what was happening in the seconds
// before it broke?"; nothing in src/ captures a rolling window yet. The screen
// is designed so the capability has somewhere to land, and is explicit that it
// is not recording.

// Flight Recorder now has a dedicated panel module (recorder-panel.js) which
// owns the live capture surface. This file no longer renders the view.

// ---------------------------------------------------------------------------
// Change Assurance
// ---------------------------------------------------------------------------
// Implemented server-side (v1.5) but with no browser surface; the workflow is
// driven through the API and SDK. Say that plainly instead of shipping a blank
// panel.

function renderChange() {
  const host = mount("change");
  if (!host || host.dataset.rendered) return;
  host.dataset.rendered = "1";

  const steps = [
    ["1", "Open a change window", "Named window attached to a case."],
    ["2", "Pin the baseline", "Select the pre-change diagnostic run."],
    ["3", "Make the change", "Faultline does not perform the change."],
    ["4", "Pin the post-change run", "Select the run to compare against."],
    ["5", "Compare", "Contract transitions, protocol state, timing and route deltas."],
    ["6", "Export", "Integrity-tagged assurance package."]
  ];

  host.innerHTML = `
    <div class="fl-split">
      <div>
        ${panel({
          label: "Workflow",
          title: "Pre-change / post-change comparison",
          meta: badge("API only", "warn"),
          body: `<ol class="fl-steps">${steps.map(([n, t, d]) =>
            `<li><span class="fl-step-n">${n}</span><div><strong>${t}</strong><span>${d}</span></div></li>`).join("")}</ol>`,
          foot: `<span>A worsening measurement is reported as a regression <em>candidate</em>, never as proof of causation.</span>`
        })}
      </div>
      <div>
        ${panel({
          label: "Interface",
          title: "Driving the workflow",
          body: `
            <p class="fl-body">This preview exposes change assurance through the v1 API and the JavaScript SDK. There is no browser workflow yet.</p>
            <pre class="fl-code">POST /api/cases/:id/change-windows
POST …/:changeId/baseline
POST …/:changeId/post-change
GET  …/:changeId/comparison
GET  …/:changeId/evidence</pre>`,
          foot: `<a href="https://github.com/weegienamja/Faultline-Network-Diagnostics/blob/main/docs/CHANGE_ASSURANCE.md" target="_blank" rel="noopener">Change assurance reference</a>`
        })}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function renderEnvironment() {
  const host = mount("environment");
  if (!host || host.dataset.rendered) return;
  host.dataset.rendered = "1";

  host.innerHTML = `
    <div class="fl-split">
      <div>
        ${panel({
          label: "Scope",
          title: "Environment manifest",
          body: `
            <p class="fl-body">
              A manifest declares the sites, targets and expected behaviours of the network under test.
              With one loaded, results are reported against your environment rather than a single
              hostname typed into a box.
            </p>
            <div class="fl-state-actions fl-state-actions-start">
              ${runtime.isPublicDemo
                ? `<button class="fl-btn fl-btn-primary" data-goto="demo">Open the hosted demo</button>`
                : `<button class="fl-btn fl-btn-primary" data-goto="live" data-live-mode="environment">Open manifest editor</button>`}
            </div>
            ${runtime.isPublicDemo ? `<p class="fl-body fl-mt-3">
              A manifest describes the network being investigated, so it is loaded by the Faultline an
              operator runs on that network. The hosted demo has no environment to declare.
            </p>` : ""}`,
          foot: `<span>Private addresses, local hostnames, MACs, SSIDs and VPN routes are never transmitted off ${escapeHtml(words.thisMachine)}.</span>`
        })}
      </div>
      <div>
        ${panel({
          label: "Targets",
          title: "What belongs in a manifest",
          body: `
            <dl class="fl-kv">
              <div><dt>sites</dt><dd>named locations</dd></div>
              <div><dt>targets</dt><dd>hosts, URLs, addresses</dd></div>
              <div><dt>expectations</dt><dd>connectivity contracts</dd></div>
            </dl>`
        })}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// The first row is the deployment's OWN measurement, and what that can do is a
// runtime fact: a hosted Function has no raw socket and therefore no ICMP and
// no traceroute, and calling its measurement "local" on a page served from a
// datacentre is the exact confusion this product exists to avoid.
const SOURCES = [
  runtime.isHosted
    ? [`${runtime.vantageLabel} measurement`, "DNS, TCP, TLS, HTTP", "none", "measured"]
    : ["Local measurement", "DNS, TCP, TLS, HTTP, ICMP, path", "none", "measured"],
  ["RIPEstat", "prefix, origin ASN, holder, RPKI, BGP", "none", "external"],
  ["Globalping", "ping from public vantage points", "none", "external"],
  ["RIPE Atlas", "connected public probes nearby", "none", "external"],
  ["IODA", "outage and anomaly signals", "none", "external"],
  ["PeeringDB", "self-published network metadata", "none", "external"],
  ["Cloudflare Radar", "outage annotations", "token", "external"]
];

function renderSettings() {
  const host = mount("settings");
  if (!host || host.dataset.rendered) return;
  host.dataset.rendered = "1";

  host.innerHTML = `
    <div class="fl-split">
      <div>
        ${panel({
          label: "Data sources",
          title: "Where evidence comes from",
          flush: true,
          body: `<div class="fl-table-wrap"><table class="fl-table" data-stack>
            <thead><tr><th>Source</th><th>Provides</th><th>Credential</th><th>Class</th></tr></thead>
            <tbody>${SOURCES.map(([name, provides, cred, kind]) => `<tr>
              <td data-label="Source">${name}</td>
              <td data-label="Provides">${provides}</td>
              <td data-label="Credential">${cred === "none" ? badge("None", "ok") : badge("Token", "warn")}</td>
              <td data-label="Class">${source(kind, kind === "measured" ? "Measured" : "External")}</td>
            </tr>`).join("")}</tbody>
          </table></div>`,
          foot: `<span>External context is supporting evidence. The deterministic engine is the only thing that decides a fault domain.</span>`
        })}
      </div>
      <div>
        ${panel({
          label: "Access",
          title: "Credentials in this session",
          body: `
            <dl class="fl-kv">
              <div><dt>Admin token</dt><dd id="settings-auth">—</dd></div>
              <div><dt>Storage</dt><dd>this browser tab only</dd></div>
              <div><dt>Persisted</dt><dd>never</dd></div>
            </dl>
            ${runtime.isPublicDemo ? `<p class="fl-body fl-mt-3">
              The public demo needs none of this. The credential belongs to whoever runs this
              deployment and gates the operator surfaces only.
            </p>` : ""}
            <!-- The topbar drops this control on a narrow screen so the public
                 call to action can keep its place. Settings is reachable from
                 the rail at every width, so the operator path lives here too
                 rather than becoming unreachable on a phone. -->
            <div class="fl-state-actions fl-state-actions-start fl-mt-3">
              <button class="fl-btn" type="button" data-action="unlock">${escapeHtml(words.unlockAction)}</button>
            </div>
            <p class="fl-body fl-mt-3">
              SDK credentials belong in the support application's backend. The end-user widget only ever
              receives a one-time invitation URL.
            </p>`
        })}
        ${panel({
          label: "Reasoning",
          title: "Diagnosis policy",
          body: `<p class="fl-body">Faultline does not use an AI or LLM API anywhere in diagnosis. Every conclusion comes from deterministic rules over observed measurements and is traceable to the evidence that produced it.</p>
            <p class="fl-body fl-mt-3">The optional Faultline Analyst explains that evidence in natural language. It runs locally, reads through read-only tools, and produces no findings of its own.</p>`
        })}
        ${panel({
          label: "Inference",
          title: "Faultline Analyst",
          body: `
            <dl class="fl-kv">
              <div><dt>Provider</dt><dd id="analyst-settings-provider">—</dd></div>
              <div><dt>Model</dt><dd id="analyst-settings-model">—</dd></div>
              <div><dt>Endpoint</dt><dd id="analyst-settings-endpoint">—</dd></div>
              <div><dt>Status</dt><dd id="analyst-settings-status">—</dd></div>
              <div><dt>Cloud inference</dt><dd>${badge("Never", "ok")}</dd></div>
              <div><dt>Conversations</dt><dd>not persisted</dd></div>
            </dl>
            <p class="fl-body fl-mt-3">
              Optional. Faultline's measurement and diagnosis work identically without it.
            </p>`
        })}
      </div>
    </div>`;

  paintSettingsAuth();
}

function paintSettingsAuth() {
  const cell = document.getElementById("settings-auth");
  if (cell) {
    cell.innerHTML = auth.unlocked
      ? badge("Unlocked", "ok")
      : badge(runtime.isPublicDemo ? "Not used by this demo" : "Locked", "idle");
  }
  void paintAnalystSettings();
}

// Runtime detail belongs here rather than in the drawer, which stays product-level.
const ANALYST_STATE_LABEL = {
  MODEL_READY: ["Ready", "ok"],
  MODEL_LOADING: ["Loading", "warn"],
  MODEL_NOT_INSTALLED: ["Model not installed", "warn"],
  OLLAMA_UNAVAILABLE: ["Runtime not running", "idle"],
  MODEL_ERROR: ["Error", "crit"]
};

async function paintAnalystSettings() {
  const statusCell = document.getElementById("analyst-settings-status");
  if (!statusCell) return;

  const set = (id, html) => {
    const cell = document.getElementById(id);
    if (cell) cell.innerHTML = html;
  };

  // On a hosted runtime the Analyst is not one credential away: there is no
  // local Ollama for it to reach, and Faultline will not substitute a cloud
  // model. "Locked" would imply a door; this one has no key.
  if (runtime.isHosted) {
    set("analyst-settings-provider", "Ollama · local only");
    set("analyst-settings-model", "—");
    set("analyst-settings-endpoint", "—");
    set("analyst-settings-status", badge("Requires local agent", "idle"));
    return;
  }

  if (!auth.unlocked) {
    set("analyst-settings-provider", "—");
    set("analyst-settings-model", "—");
    set("analyst-settings-endpoint", "—");
    set("analyst-settings-status", badge("Locked", "idle"));
    return;
  }

  try {
    const response = await fetch("/api/analyst/status", { headers: { authorization: `Bearer ${auth.token}` } });
    if (!response.ok) throw new Error("unavailable");
    const status = await response.json();
    const [label, tone] = ANALYST_STATE_LABEL[status.state] || ["Unavailable", "idle"];
    set("analyst-settings-provider", escapeHtml(status.provider || "Ollama"));
    set("analyst-settings-model", `<code>${escapeHtml(status.model || "—")}</code>`);
    // The literal endpoint is a runtime detail, but a wrong one must be visible.
    set("analyst-settings-endpoint", `Local · <code>${escapeHtml(status.endpoint || "—")}</code>`);
    set("analyst-settings-status", badge(label, tone));
  } catch {
    set("analyst-settings-provider", "Ollama");
    set("analyst-settings-status", badge("Unavailable", "idle"));
  }
}
window.addEventListener("faultline-auth-changed", paintSettingsAuth);

// ---------------------------------------------------------------------------
// Topology empty state (the panels themselves are revealed by app.js)
// ---------------------------------------------------------------------------

function renderTopologyFallback() {
  const slot = document.getElementById("topology-empty-slot");
  if (!slot) return;
  const hasTopology = !document.getElementById("topology-panel")?.hidden;
  const hasRoute = !document.getElementById("route-panel")?.hidden;
  // The old empty state promised a map that a hosted deployment can never draw
  // - the adapter, routing and neighbour evidence it is inferred from only
  // exists on the endpoint - and sent the visitor to a locked operator page to
  // get it. Say which evidence is missing, and offer the route that works.
  slot.innerHTML = (hasTopology || hasRoute) ? "" : `<section class="fl-panel">${state({
    icon: "◇",
    title: runtime.isHosted ? "No endpoint topology evidence here" : "No topology evidence yet",
    body: runtime.isHosted
      ? `Topology is inferred from adapter, routing and neighbour evidence, which is collected on the machine being investigated. ${runtime.vantageLabel} has none of a visitor's, so this deployment draws no map. The recorded VPN routing investigation shows the same evidence from a real capture.`
      : "Topology is inferred from adapter, routing and neighbour evidence collected during a diagnostic. Run one against a real target and the map appears here.",
    actions: runtime.isPublicDemo
      ? `<button class="fl-btn fl-btn-primary" data-goto="demo">Open the hosted demo</button>`
      : `<button class="fl-btn fl-btn-primary" data-goto="live">Run a live diagnostic</button>`
  })}</section>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function renderForView(view) {
  if (view === "change") renderChange();
  if (view === "environment") renderEnvironment();
  if (view === "settings") renderSettings();
  if (view === "topology") renderTopologyFallback();
}

window.addEventListener("faultline-view", event => renderForView(event.detail.view));

// shell.js routes during its own module evaluation, which happens before this
// module is evaluated. Loading straight into #/recorder would therefore miss
// the initial event entirely, so render whatever view is already active. The
// per-view `dataset.rendered` guard keeps this idempotent.
renderForView(currentView());

// Cross-view navigation from buttons rendered anywhere.
document.addEventListener("click", event => {
  const target = event.target.closest("[data-goto]");
  if (!target) return;
  goTo(target.dataset.goto);
  if (target.dataset.liveMode) {
    window.dispatchEvent(new CustomEvent("faultline-live-mode", { detail: { mode: target.dataset.liveMode } }));
  }
});

export { renderOverviewTiles };
