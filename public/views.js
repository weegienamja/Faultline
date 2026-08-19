// Surfaces that have structure but no dedicated panel module yet:
// the Overview summary row, Flight Recorder, Change Assurance, Environment
// and Settings.
//
// Where a capability is not implemented, this file renders a designed empty
// state that says so. It does not render placeholder charts. A dashboard that
// invents data to look complete is the single fastest way to lose an
// operator's trust, and Faultline's whole argument is that every value on
// screen is traceable to a measurement.

import { mount, panel, tile, state, badge, source, disclose, auth, goTo, currentView } from "./shell.js";

// ---------------------------------------------------------------------------
// Rail credential indicator
// ---------------------------------------------------------------------------

function paintAuthIndicator() {
  const dot = document.getElementById("rail-auth-dot");
  const text = document.getElementById("rail-auth-text");
  if (!dot || !text) return;
  dot.dataset.status = auth.unlocked ? "ok" : "idle";
  text.textContent = auth.unlocked ? "Live data unlocked" : "Live data locked";
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
  if (!incident) return;

  const m = incident.metrics || {};
  const severity = severityOf(incident);
  const online = probes.filter(p => p.health === "online").length;
  const worst = incidents.filter(i => severityOf(i) === "crit").length;

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
      label: "Reference incidents",
      value: String(incidents.length),
      sub: worst ? `${worst} failing` : "worked examples",
      status: "idle"
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

function renderRecorder() {
  const host = mount("recorder");
  if (!host || host.dataset.rendered) return;
  host.dataset.rendered = "1";

  host.innerHTML = `
    <div class="fl-grid">
      <div class="fl-col-8">
        ${panel({
          label: "Capture",
          title: "Rolling evidence buffer",
          meta: badge("Not recording", "idle"),
          body: state({
            icon: "⏺",
            title: "No capture session is running",
            body: "Flight Recorder keeps a continuous low-rate measurement window so a fault that lasts ten seconds still leaves evidence behind. It is specified but not yet implemented — a one-shot Live Diagnostic is the current way to capture evidence, and it must be run while the fault is happening.",
            actions: `<button class="fl-btn fl-btn-primary" data-goto="live">Run a live diagnostic</button>
                      <a class="fl-btn" href="https://github.com/weegienamja/Faultline/blob/main/ROADMAP.md">Roadmap</a>`
          }),
          foot: `<span>Tracked on the roadmap under <strong>Intermittent faults</strong>.</span>`
        })}
      </div>
      <div class="fl-col-4">
        ${panel({
          label: "Specification",
          title: "What it will capture",
          body: `
            <dl class="fl-kv">
              <div><dt>Window</dt><dd>rolling, bounded</dd></div>
              <div><dt>Rate</dt><dd>low, continuous</dd></div>
              <div><dt>Signals</dt><dd>DNS · TCP · TLS · ICMP · path</dd></div>
              <div><dt>Trigger</dt><dd>manual or contract breach</dd></div>
              <div><dt>Output</dt><dd>evidence package</dd></div>
            </dl>
            <p class="fl-body" style="margin-top:12px">
              The buffer is bounded by design. Faultline is not a packet-capture warehouse: it records
              measurements and outcomes, never payloads, credentials or browsing activity.
            </p>`
        })}
      </div>
    </div>`;
}

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
    <div class="fl-grid">
      <div class="fl-col-7">
        ${panel({
          label: "Workflow",
          title: "Pre-change / post-change comparison",
          meta: badge("API only", "warn"),
          body: `<ol class="fl-steps">${steps.map(([n, t, d]) =>
            `<li><span class="fl-step-n">${n}</span><div><strong>${t}</strong><span>${d}</span></div></li>`).join("")}</ol>`,
          foot: `<span>A worsening measurement is reported as a regression <em>candidate</em>, never as proof of causation.</span>`
        })}
      </div>
      <div class="fl-col-5">
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
          foot: `<a href="https://github.com/weegienamja/Faultline/blob/main/docs/CHANGE_ASSURANCE.md">Change assurance reference</a>`
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
    <div class="fl-grid">
      <div class="fl-col-7">
        ${panel({
          label: "Scope",
          title: "Environment manifest",
          body: `
            <p class="fl-body">
              A manifest declares the sites, targets and expected behaviours of the network under test.
              With one loaded, results are reported against your environment rather than a single
              hostname typed into a box.
            </p>
            <div class="fl-state-actions" style="justify-content:flex-start;margin-top:16px">
              <button class="fl-btn fl-btn-primary" data-goto="live" data-live-mode="environment">Open manifest editor</button>
            </div>`,
          foot: `<span>Private addresses, local hostnames, MACs, SSIDs and VPN routes are never transmitted off this machine.</span>`
        })}
      </div>
      <div class="fl-col-5">
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

const SOURCES = [
  ["Local measurement", "DNS, TCP, TLS, HTTP, ICMP, path", "none", "measured"],
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
    <div class="fl-grid">
      <div class="fl-col-7">
        ${panel({
          label: "Data sources",
          title: "Where evidence comes from",
          flush: true,
          body: `<div class="fl-table-wrap"><table class="fl-table">
            <thead><tr><th>Source</th><th>Provides</th><th>Credential</th><th>Class</th></tr></thead>
            <tbody>${SOURCES.map(([name, provides, cred, kind]) => `<tr>
              <td>${name}</td>
              <td>${provides}</td>
              <td>${cred === "none" ? badge("None", "ok") : badge("Token", "warn")}</td>
              <td>${source(kind, kind === "measured" ? "Measured" : "External")}</td>
            </tr>`).join("")}</tbody>
          </table></div>`,
          foot: `<span>External context is supporting evidence. The deterministic engine is the only thing that decides a fault domain.</span>`
        })}
      </div>
      <div class="fl-col-5">
        ${panel({
          label: "Access",
          title: "Credentials in this session",
          body: `
            <dl class="fl-kv">
              <div><dt>Admin token</dt><dd id="settings-auth">—</dd></div>
              <div><dt>Storage</dt><dd>this browser tab only</dd></div>
              <div><dt>Persisted</dt><dd>never</dd></div>
            </dl>
            <p class="fl-body" style="margin-top:12px">
              SDK credentials belong in the support application's backend. The end-user widget only ever
              receives a one-time invitation URL.
            </p>`
        })}
        ${panel({
          label: "Reasoning",
          title: "Diagnosis policy",
          body: `<p class="fl-body">Faultline does not use an AI or LLM API anywhere in diagnosis. Every conclusion comes from deterministic rules over observed measurements and is traceable to the evidence that produced it.</p>`
        })}
      </div>
    </div>`;

  paintSettingsAuth();
}

function paintSettingsAuth() {
  const cell = document.getElementById("settings-auth");
  if (cell) cell.innerHTML = auth.unlocked ? badge("Unlocked", "ok") : badge("Locked", "idle");
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
  slot.innerHTML = (hasTopology || hasRoute) ? "" : `<section class="fl-panel">${state({
    icon: "◇",
    title: "No topology evidence yet",
    body: "Topology is inferred from adapter, routing and neighbour evidence collected during a diagnostic. Run one against a real target and the map appears here.",
    actions: `<button class="fl-btn fl-btn-primary" data-goto="live">Run a live diagnostic</button>`
  })}</section>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function renderForView(view) {
  if (view === "recorder") renderRecorder();
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
