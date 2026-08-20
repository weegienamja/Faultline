// The hosted public demo surface.
//
// This is the first screen a stranger sees, and it has six seconds to answer:
// what is Faultline, is this a demo, who is taking the measurements, can I run
// something now, what needs an agent, and what does the endpoint half look
// like. It is built from the same panel, tile, badge and state primitives as
// every other surface, because the demo has to feel like the product rather
// than like a brochure in front of it.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// ------------------------------------
// A measurement taken by the hosted deployment is labelled with the hosted
// vantage. Never LOCAL, never "from this machine", never anything a visitor
// could read as "Faultline looked at my network". The vantage label comes from
// the runtime capability model and from the run's own `vantage` field, and this
// module never writes one by hand.

import { badge, escapeHtml, mount, onView, panel, runtime, source, state, statusOf, tile } from "./shell.js";

const host = mount("demo");

/** Populated from /api/demo/capabilities on first view. */
let capabilities = null;
let incidents = [];
let lastRun = null;
let running = false;
let openInvestigation = null;
let loadingInvestigation = null;
const investigationCache = new Map();

const ms = value => (Number.isFinite(Number(value)) ? `${Number(value) < 10 ? Number(value).toFixed(1) : Math.round(Number(value))} ms` : "—");
const clock = value => (value ? new Date(value).toISOString().slice(11, 19) : "—");

function vantageLabel() {
  const region = runtime.vantageRegion;
  return region ? `${runtime.vantageLabel} · ${region}` : runtime.vantageLabel;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", accept: "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.code || null;
    throw error;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Hero — the thing a visitor can do immediately
// ---------------------------------------------------------------------------

function hero() {
  const allowlist = capabilities?.demo?.liveDiagnostic?.allowlist || [];
  const suggestions = allowlist.slice(0, 6);

  return `<section class="fl-panel fl-demo-hero">
    <div class="fl-panel-body">
      <span class="fl-label">Hosted demo · no account required</span>
      <h2 class="fl-demo-title">Diagnose a public Internet target</h2>
      <p class="fl-body fl-prose">
        Faultline captures evidence for intermittent network faults, isolates the condition responsible,
        and preserves the result as a portable evidence package. Run one now: this deployment measures
        DNS, TCP, TLS and HTTP for real, and correlates the result against independent public vantages.
      </p>

      <form class="fl-demo-form" id="demo-form">
        <input class="fl-input fl-input-mono" id="demo-target" name="target"
               value="github.com" autocomplete="off" spellcheck="false"
               aria-label="Public target hostname" />
        <button class="fl-btn fl-btn-primary" type="submit" id="demo-run">Run Faultline</button>
      </form>

      ${suggestions.length ? `<div class="fl-demo-chips" role="group" aria-label="Suggested targets">
        ${suggestions.map(entry => `<button class="fl-chip" type="button" data-target="${escapeHtml(entry)}">${escapeHtml(entry)}</button>`).join("")}
      </div>` : ""}

      <p class="fl-demo-provenance">
        ${source("measured", vantageLabel())}
        <span>Real measurements originate from Faultline's hosted deployment — not from your device, browser or LAN.</span>
      </p>
      <p class="fl-status-line" id="demo-status" data-tone="info"></p>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Who can see what
// ---------------------------------------------------------------------------
// The single most important panel on the page. A hosted network tool that is
// vague about its vantage point is indistinguishable from one that is lying.

function capabilityColumns() {
  const endpointOnly = capabilities?.endpointOnly || [];

  const column = (label, meta, rows, tone) => `<div class="fl-vantage-col" data-tone="${tone}">
    <div class="fl-vantage-head">
      <span class="fl-label">${escapeHtml(label)}</span>
      ${meta}
    </div>
    <ul class="fl-vantage-list">
      ${rows.map(([mark, text, note]) => `<li data-mark="${mark}">
        <span class="fl-vantage-mark" aria-hidden="true">${mark === "yes" ? "✓" : "○"}</span>
        <span>${escapeHtml(text)}${note ? `<small>${escapeHtml(note)}</small>` : ""}</span>
      </li>`).join("")}
    </ul>
  </div>`;

  return panel({
    label: "Vantage",
    title: "What each vantage can actually observe",
    meta: badge("Honest scope", "ok"),
    body: `<div class="fl-vantage-grid">
      ${column(vantageLabel(), source("measured", "Measured here"), [
        ["yes", "DNS", "system resolver plus 1.1.1.1, 8.8.8.8, 9.9.9.9 compared"],
        ["yes", "TCP", "connect timing to the validated address"],
        ["yes", "TLS", "handshake, version, cipher, certificate"],
        ["yes", "HTTP", "status and time to first byte, redirects re-validated"]
      ], "ok")}

      ${column("Public vantages", source("external", "Independent"), [
        ["yes", "Globalping", "ping from public probes that are not this deployment"],
        ["yes", "RIPEstat", "prefix, origin ASN, holder, RPKI, BGP visibility"],
        ["yes", "IODA / PeeringDB", "outage signals and self-published network metadata"]
      ], "external")}

      ${column("Your endpoint", badge("Requires Faultline Agent", "warn"),
        (endpointOnly.length
          ? endpointOnly.map(item => ["no", item.label, null])
          : [["no", "Wi-Fi, gateway, routes, VPN, neighbours", null]]),
        "idle")}
    </div>`,
    foot: `<span>Nothing on this page reports on your own network. A hosted deployment has no path to it, and Faultline will not claim a reading it did not take. The recorded investigations below are how the endpoint half is demonstrated.</span>`
  });
}

// ---------------------------------------------------------------------------
// Live result
// ---------------------------------------------------------------------------

function stageStrip(run) {
  return `<div class="fl-stage-strip">${run.observed.stages.map(entry => `
    <div class="fl-stage" data-status="${statusOf(entry.state)}">
      <span class="fl-stage-name">${escapeHtml(entry.name)}</span>
      <span class="fl-stage-state">${escapeHtml(String(entry.state).toUpperCase())}</span>
      <span class="fl-stage-ms">${entry.ms == null ? "—" : ms(entry.ms)}</span>
      <span class="fl-stage-detail">${escapeHtml(entry.detail || "")}</span>
    </div>`).join("")}</div>`;
}

function findingRows(findings, { notMeasured = false } = {}) {
  if (!findings.length) return `<p class="fl-meta">None.</p>`;
  return `<div class="fl-evidence-set">${findings.map(item => `
    <div class="fl-evidence" data-status="${notMeasured ? "idle" : statusOf(item.status)}">
      <div class="fl-evidence-head">
        <span class="fl-evidence-title">${escapeHtml(item.label)}</span>
        ${notMeasured ? badge("Not measured", "idle") : badge(String(item.status).toUpperCase(), statusOf(item.status))}
      </div>
      <p class="fl-body">${escapeHtml(item.detail || "")}</p>
      ${item.value ? `<span class="fl-evidence-value">${escapeHtml(item.value)}</span>` : ""}
      ${item.requires ? `<span class="fl-meta">Requires: ${escapeHtml(item.requires)}</span>` : ""}
    </div>`).join("")}</div>`;
}

function resolverPanel(run) {
  const dns = run.observed.dns;
  if (!dns?.measured) return "";
  const rows = [
    { label: "System resolver (hosted)", ok: dns.system?.a?.ok, addresses: dns.system?.a?.addresses || [], elapsed: dns.system?.a?.elapsedMs },
    ...(dns.comparisons || []).map(entry => ({ label: entry.label, ok: entry.ok, addresses: entry.addresses || [], elapsed: entry.elapsedMs }))
  ];
  const agreement = dns.agreement?.state || "unknown";

  return panel({
    label: "Resolver comparison",
    title: agreement === "consistent" ? "Resolvers agree" : agreement === "divergent" ? "Resolvers disagree" : "Resolver comparison",
    meta: `${source("measured", vantageLabel())}${badge(String(agreement).toUpperCase(), agreement === "consistent" ? "ok" : agreement === "divergent" ? "warn" : "idle")}`,
    flush: true,
    body: `<div class="fl-table-wrap"><table class="fl-table" data-stack>
      <thead><tr><th>Resolver</th><th>Answer</th><th>Time</th></tr></thead>
      <tbody>${rows.map(row => `<tr>
        <td data-label="Resolver">${escapeHtml(row.label)}</td>
        <td data-label="Answer">${row.ok ? `<code>${escapeHtml(row.addresses.join(", ") || "—")}</code>` : badge("No answer", "warn")}</td>
        <td data-label="Time">${row.elapsed == null ? "—" : ms(row.elapsed)}</td>
      </tr>`).join("")}</tbody>
    </table></div>`,
    foot: `<span>A resolver that answers differently from its peers is exactly the fault the recorded DNS investigation below demonstrates end to end.</span>`
  });
}

function tlsPanel(run) {
  const tls = run.observed.tls;
  if (!tls?.ok) return "";
  const cert = tls.certificate || {};
  return panel({
    label: "Transport",
    title: "TLS and certificate",
    meta: source("measured", vantageLabel()),
    body: `<dl class="fl-kv">
      <div><dt>Protocol</dt><dd><code>${escapeHtml(tls.protocol || "—")}</code></dd></div>
      <div><dt>Cipher</dt><dd><code>${escapeHtml(tls.cipher || "—")}</code></dd></div>
      <div><dt>ALPN</dt><dd><code>${escapeHtml(tls.alpn || "—")}</code></dd></div>
      <div><dt>Handshake</dt><dd>${ms(tls.elapsedMs)}</dd></div>
      <div><dt>Subject</dt><dd>${escapeHtml(cert.subject || "—")}</dd></div>
      <div><dt>Issuer</dt><dd>${escapeHtml(cert.issuer || "—")}</dd></div>
      <div><dt>Expires</dt><dd>${cert.validTo && cert.validTo !== "unknown" ? `${escapeHtml(cert.validTo.slice(0, 10))} · ${cert.daysRemaining} days` : "—"}</dd></div>
      <div><dt>Chain</dt><dd>${tls.chainTrusted ? badge("Trusted", "ok") : badge("Not trusted", "warn")}</dd></div>
    </dl>`
  });
}

function distributedPanel(run) {
  const distributed = run.distributed;
  if (distributed.status !== "ok" || !distributed.data) {
    return panel({
      label: "Independent vantage",
      title: "Public vantage measurement",
      meta: badge("Unavailable", "idle"),
      body: `<p class="fl-body">${escapeHtml(distributed.reason || distributed.error || "No public vantage measurement was returned for this run.")}</p>`,
      foot: `<span>Globalping is a public service. When it is unavailable, Faultline says so rather than reporting a single-vantage result as if it were corroborated.</span>`
    });
  }

  const summary = distributed.data.summary || {};
  const results = distributed.data.results || distributed.data.probes || [];
  return panel({
    label: "Independent vantage",
    title: "Measured from public probes",
    meta: `${source("external", "GLOBALPING")}${badge(`${summary.reachable ?? 0}/${summary.total ?? 0} reachable`, summary.unreachable ? "warn" : "ok")}`,
    body: `<div class="fl-tiles">
        ${tile({ label: "Vantages", value: String(summary.total ?? 0), status: "idle" })}
        ${tile({ label: "Reachable", value: String(summary.reachable ?? 0), status: summary.unreachable ? "warn" : "ok" })}
        ${tile({ label: "Median latency", value: summary.medianLatencyMs == null ? "—" : String(summary.medianLatencyMs), unit: "ms", status: "idle" })}
      </div>
      ${Array.isArray(results) && results.length ? `<div class="fl-table-wrap fl-mt-3"><table class="fl-table" data-stack>
        <thead><tr><th>Probe</th><th>Network</th><th>Latency</th><th>Loss</th></tr></thead>
        <tbody>${results.slice(0, 6).map(entry => `<tr>
          <td data-label="Probe">${escapeHtml([entry.city, entry.country].filter(Boolean).join(", ") || entry.id || "probe")}</td>
          <td data-label="Network">${escapeHtml(entry.network || (entry.asn ? `AS${entry.asn}` : "—"))}</td>
          <td data-label="Latency">${entry.latencyMs == null ? "—" : ms(entry.latencyMs)}</td>
          <td data-label="Loss">${entry.lossPct == null ? "—" : `${entry.lossPct}%`}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : ""}`,
    foot: `<span>These probes are not this deployment. Two independent vantages agreeing is what separates "the service is down" from "the path from here is down".</span>`
  });
}

function contextPanel(run) {
  const context = run.internetContext;
  if (!context?.enriched) return "";
  const routing = context.routing?.data || context.routing || {};
  const metadata = context.networkMetadata?.data || {};
  const rows = [
    ["Resolved address", run.target.resolvedAddress],
    ["Announced prefix", routing.prefix],
    ["Origin ASN", routing.originAsn ? `AS${routing.originAsn}` : null],
    ["Network", routing.asnName || metadata.name],
    ["RPKI", routing.rpkiStatus],
    ["Country", metadata.country || routing.country]
  ].filter(([, value]) => value);

  if (!rows.length) return "";

  return panel({
    label: "Public Internet context",
    title: "Routing and ownership",
    meta: source("external", "RIPESTAT"),
    body: `<dl class="fl-kv">${rows.map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd><code>${escapeHtml(value)}</code></dd></div>`).join("")}</dl>`,
    foot: `<span>Context, never proof. Routing and ownership metadata is deliberately excluded from the deterministic engine's input so a third-party API can never move a fault domain.</span>`
  });
}

function resultSection() {
  if (!lastRun) return "";
  const run = lastRun;
  const diagnosis = run.deterministic.diagnosis;
  const scope = run.deterministic.vantageScope;
  const severity = diagnosis.severity === "healthy" ? "ok" : diagnosis.severity === "warning" ? "warn" : "crit";

  return `<div class="fl-demo-results" id="demo-results">
    ${panel({
      label: "Deterministic diagnosis",
      title: diagnosis.faultDomainLabel,
      status: severity,
      meta: `${source("deterministic", "DETERMINISTIC")}${badge(`${diagnosis.confidence}% confidence`, severity)}`,
      body: `<p class="fl-body fl-prose">${escapeHtml(diagnosis.summary)}</p>
        <div class="fl-tiles fl-mt-3">
          ${tile({ label: "Target", value: run.target.host, sub: `<code>${escapeHtml(run.target.resolvedAddress)}</code>`, status: "idle" })}
          ${tile({ label: "Vantage", value: run.vantage.label, sub: escapeHtml(run.vantage.region || "hosted deployment"), status: "idle" })}
          ${tile({ label: "TLS handshake", value: run.observed.tls?.ok ? String(Math.round(run.observed.tls.elapsedMs)) : "—", unit: run.observed.tls?.ok ? "ms" : "", status: "idle" })}
          ${tile({ label: "Time to first byte", value: run.observed.http?.ok ? String(Math.round(run.observed.http.ttfbMs)) : "—", unit: run.observed.http?.ok ? "ms" : "", status: "idle" })}
        </div>
        ${stageStrip(run)}`,
      foot: `<span>Deterministic rules over observed measurements. No model, no inference, no cloud API anywhere in this conclusion.</span>`
    })}

    ${panel({
      label: "Why Faultline reached this conclusion",
      title: "Supporting evidence",
      meta: source("measured", vantageLabel()),
      body: findingRows(scope.inScope)
    })}

    ${panel({
      label: "Out of scope for this vantage",
      title: "Not measured from here",
      meta: badge("Requires Faultline Agent", "warn"),
      body: `<p class="fl-body fl-prose fl-mb-3">${escapeHtml(scope.note)}</p>
        ${findingRows(scope.notObservable, { notMeasured: true })}`,
      foot: `<span>${escapeHtml(run.notMeasured.reason)}</span>`
    })}

    ${resolverPanel(run)}
    ${distributedPanel(run)}
    ${tlsPanel(run)}
    ${contextPanel(run)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Recorded investigations
// ---------------------------------------------------------------------------

function incidentCards() {
  if (!incidents.length) {
    return panel({
      label: "Recorded evidence",
      title: "Recorded investigations",
      body: state({ icon: "⏺", title: "Loading recorded investigations…" })
    });
  }

  return panel({
    label: "The endpoint half of Faultline",
    title: "Recorded investigations",
    meta: source("simulated", "RECORDED DEMO INCIDENT"),
    body: `<p class="fl-body fl-prose fl-mb-3">
        These three faults live on an endpoint's own network, so a hosted deployment cannot reproduce them.
        Each one is a recorded scenario replayed through Faultline's production Flight Recorder and Network
        Bisect engines — the capture, the comparison, the experiment selection and the verdict are real
        product behaviour; the network being described is not.
      </p>
      <div class="fl-demo-cards">
        ${incidents.map(entry => `<article class="fl-demo-card"${openInvestigation === entry.slug ? " data-open" : ""}>
          <div class="fl-demo-card-head">
            <h3>${escapeHtml(entry.title)}</h3>
            ${badge(entry.id, "idle", { code: true })}
          </div>
          <p class="fl-body">${escapeHtml(entry.subtitle)}</p>
          <p class="fl-meta">${escapeHtml(entry.whyRecorded)}</p>
          <div class="fl-demo-card-foot">
            ${source("simulated", "RECORDED")}
            <button class="fl-btn fl-btn-sm fl-btn-primary" type="button" data-replay="${escapeHtml(entry.slug)}"
              ${loadingInvestigation === entry.slug ? "disabled" : ""}>
              ${loadingInvestigation === entry.slug ? "Replaying…" : openInvestigation === entry.slug ? "Close investigation" : "Replay investigation"}
            </button>
          </div>
        </article>`).join("")}
      </div>`,
    foot: `<span>Provenance travels with the evidence: every sample, the incident record, the isolation run and the exported capsule are all marked simulated.</span>`
  });
}

/** BEFORE → TRIGGER → DURING → AFTER, using the product's chronology rail. */
function chronology(capture) {
  const stage = ({ kind = "phase", event = null, label, headline, detail, at, status = "idle", level = 0, shift = null }) => {
    const style = [`--fl-chrono-level:${level}`];
    if (shift) style.push(`--fl-shift-from:var(--fl-${shift})`);
    return `<li class="fl-chrono-stage" data-kind="${kind}"${event ? ` data-event="${event}"` : ""}
        data-status="${escapeHtml(status)}"${shift ? " data-shift" : ""} style="${style.join(";")}">
      <span class="fl-chrono-rail" aria-hidden="true"></span>
      ${kind === "event" ? `<span class="fl-chrono-marker" aria-hidden="true"></span>` : ""}
      <div class="fl-chrono-head">
        <span class="fl-chrono-label">${escapeHtml(label)}</span>
        <time class="fl-chrono-time">${clock(at)}</time>
      </div>
      <div class="fl-chrono-state">${escapeHtml(headline)}</div>
      <div class="fl-chrono-detail">${escapeHtml(detail)}</div>
    </li>`;
  };

  const windows = capture.windows;
  const recovery = capture.recovery;
  const stages = [
    stage({
      label: "Before",
      status: windows.before.count ? "ok" : "idle",
      headline: windows.before.count ? "Reachable" : "No prior samples",
      detail: `${windows.before.count} samples · the healthy window the failure is compared against`,
      at: windows.before.to,
      level: 0
    }),
    stage({
      kind: "event",
      event: "trigger",
      label: "Trigger",
      status: "crit",
      headline: capture.trigger.summary || capture.trigger.type,
      detail: `Rule: ${capture.trigger.type}`,
      at: capture.trigger.at,
      level: 1,
      shift: "ok"
    }),
    stage({
      label: "During",
      status: "crit",
      headline: capture.observedChange?.capturedWindow?.reasons?.[0] || "Target unreachable",
      detail: `${windows.during.count} samples captured while the fault was present`,
      at: windows.during.from,
      level: 1
    }),
    stage({
      label: "After",
      status: recovery ? "ok" : "crit",
      headline: recovery ? "Recovered" : "No recovery observed",
      detail: `${windows.after.count} samples${recovery ? " · reachable again" : ""}`,
      at: recovery ? recovery.at : windows.after.to,
      level: recovery ? 0 : 1,
      shift: recovery ? "crit" : null
    })
  ];

  return `<ol class="fl-chrono" data-simulated>${stages.join("")}</ol>`;
}

function timelineTable(rows) {
  const interesting = rows.filter((row, index) => index === 0 || row.state !== rows[index - 1].state || row.phase !== rows[index - 1].phase);
  const shown = interesting.length >= 4 ? interesting : rows.slice(0, 12);
  return `<div class="fl-table-wrap"><table class="fl-table fl-table-compact" data-stack>
    <thead><tr><th>Time</th><th>Window</th><th>State</th><th>Target</th><th>Interface</th><th>Resolvers</th><th>Answer</th></tr></thead>
    <tbody>${shown.slice(0, 14).map(row => `<tr data-status="${statusOf(row.state)}">
      <td data-label="Time"><code>${clock(row.at)}</code></td>
      <td data-label="Window">${escapeHtml(row.window)}</td>
      <td data-label="State">${badge(String(row.state).toUpperCase(), statusOf(row.state), { code: true })}</td>
      <td data-label="Target">${escapeHtml(row.targetTcp || "—")}${row.targetTcpError ? ` <small>${escapeHtml(row.targetTcpError)}</small>` : ""}</td>
      <td data-label="Interface">${escapeHtml(row.activeInterface || "—")}${row.vpn ? " <small>VPN</small>" : ""}</td>
      <td data-label="Resolvers"><code>${escapeHtml((row.resolvers || []).join(", ") || "—")}</code></td>
      <td data-label="Answer"><code>${escapeHtml(row.resolvedAddress || "—")}</code></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function differencesTable(observedChange) {
  const changes = observedChange?.differences || [];
  const unchanged = observedChange?.unchanged || [];
  return `<div class="fl-table-wrap"><table class="fl-table" data-stack>
    <thead><tr><th>Property</th><th>Healthy</th><th>Failing</th><th>Testable</th></tr></thead>
    <tbody>${changes.map(change => `<tr>
      <td data-label="Property">${escapeHtml(change.label)}</td>
      <td data-label="Healthy"><code>${escapeHtml(change.from)}</code></td>
      <td data-label="Failing"><code>${escapeHtml(change.to)}</code></td>
      <td data-label="Testable">${change.bisectAxis ? badge(change.bisectAxis, "ok", { code: true }) : badge("No experiment", "idle")}</td>
    </tr>`).join("")}</tbody>
  </table>
  ${unchanged.length ? `<p class="fl-meta fl-mt-2">Unchanged across both windows: ${escapeHtml(unchanged.map(entry => entry.label).join(", "))}.</p>` : ""}
  </div>`;
}

function isolateSection(isolate) {
  if (!isolate.available) {
    return panel({
      label: "Isolate",
      title: "Network Bisect",
      body: state({ icon: "⑂", title: "No testable condition", body: isolate.reason })
    });
  }

  const verdict = isolate.verdict;
  const confirmed = isolate.confirmation?.confirmed;

  return panel({
    label: "Isolate · which variable changes the outcome",
    title: verdict.headline,
    status: confirmed ? "ok" : "warn",
    meta: `${source("simulated", "REPLAYED EXPERIMENT")}${badge(verdict.classification.replace(/_/g, " "), confirmed ? "ok" : "warn")}`,
    body: `<p class="fl-body fl-prose">${escapeHtml(verdict.claim)}</p>
      ${verdict.detail ? `<p class="fl-body fl-prose fl-mt-2">${escapeHtml(verdict.detail)}</p>` : ""}

      <div class="fl-tiles fl-mt-3">
        ${tile({ label: "Baseline", value: `${isolate.baseline.passes}/${isolate.baseline.total}`, sub: escapeHtml(isolate.baseline.reason || isolate.baseline.state), status: isolate.baseline.state === "FAILED_BASELINE" ? "crit" : "ok" })}
        ${tile({ label: "Experiments run", value: String(isolate.counters.executed), sub: `${isolate.counters.connections} trials`, status: "idle" })}
        ${tile({ label: "A/B pairs", value: String(isolate.confirmation?.pairs ?? 0), sub: confirmed ? "difference held" : "not confirmed", status: confirmed ? "ok" : "warn" })}
        ${tile({ label: "Stopping rule", value: String(verdict.stop).replace(/_/g, " "), status: "idle" })}
      </div>

      <div class="fl-table-wrap fl-mt-3"><table class="fl-table" data-stack>
        <thead><tr><th>Condition varied</th><th>Result</th><th>Passes</th><th>Stage</th><th>Why this experiment</th></tr></thead>
        <tbody>${isolate.executed.map(entry => `<tr>
          <td data-label="Condition varied">${escapeHtml(entry.axisLabel)}: ${escapeHtml(entry.label)}</td>
          <td data-label="Result">${badge(entry.result, statusOf(entry.result), { code: true })}</td>
          <td data-label="Passes">${entry.passes}/${entry.total}</td>
          <td data-label="Stage">${escapeHtml(entry.stage || "—")}</td>
          <td data-label="Why this experiment">${escapeHtml(entry.selectionReason || "")}</td>
        </tr>`).join("")}</tbody>
      </table></div>

      ${isolate.confirmation ? `<div class="fl-bisect-seq fl-mt-3" aria-label="Interleaved A/B confirmation">
        <span class="fl-label">Interleaved confirmation</span>
        <code>${isolate.confirmation.sequence.map(entry => `${entry.arm === "baseline" ? "A" : "B"}${entry.verdict === "pass" ? "+" : "−"}`).join(" ")}</code>
        <span class="fl-meta">Alternating the arms is what stops a network that simply recovered from being read as a finding.</span>
      </div>` : ""}`,
    foot: `<span>${escapeHtml(isolate.evidence.observed)}</span>`
  });
}

function investigationSection(view) {
  return `<div class="fl-demo-investigation" data-slug="${escapeHtml(view.slug)}">
    ${panel({
      label: "Recorded demo incident",
      title: view.title,
      status: "warn",
      meta: `${source("simulated", view.notice.label)}${badge(view.id, "idle", { code: true })}`,
      body: `<p class="fl-body fl-prose">${escapeHtml(view.notice.detail)}</p>
        <p class="fl-body fl-prose fl-mt-2">${escapeHtml(view.whyRecorded)}</p>`
    })}

    ${panel({
      label: "Capture · what changed",
      title: "Flight Recorder incident",
      meta: source("simulated", "RECORDED SAMPLES"),
      body: `<p class="fl-body fl-prose fl-mb-3">${escapeHtml(view.story.capture)}</p>
        ${chronology(view.capture)}
        <h3 class="fl-label fl-mt-3">Sample record</h3>
        ${timelineTable(view.capture.timeline)}
        <h3 class="fl-label fl-mt-3">Difference between the healthy and failing windows</h3>
        ${differencesTable(view.capture.observedChange)}
        <p class="fl-body fl-prose fl-mt-3">${escapeHtml(view.capture.observedChange.statement || "")}</p>`,
      foot: `<span>${escapeHtml(view.capture.epistemics.limit)}</span>`
    })}

    ${(() => {
      const section = isolateSection(view.isolate);
      return `<p class="fl-body fl-prose fl-mb-3">${escapeHtml(view.story.isolate)}</p>${section}`;
    })()}

    ${panel({
      label: "Explain · what the evidence means",
      title: "Deterministic explanation",
      meta: `${source("deterministic", "DETERMINISTIC")}${badge("Analyst unavailable", "idle")}`,
      body: `<p class="fl-body fl-prose">${escapeHtml(view.story.explain)}</p>
        ${view.explain.deterministic ? `<div class="fl-claim fl-mt-3">
          <strong>${escapeHtml(view.explain.deterministic.headline)}</strong>
          <p class="fl-body">${escapeHtml(view.explain.deterministic.claim)}</p>
          ${view.explain.deterministic.workaround ? `<p class="fl-body fl-mt-2">${escapeHtml(view.explain.deterministic.workaround)}</p>` : ""}
        </div>` : ""}
        <p class="fl-meta fl-mt-3">Faultline Analyst requires a local Faultline Agent running Ollama, so it is not available on this hosted deployment. It is an interpretation layer and never produces a finding: everything above is the deterministic engine's, with or without it.</p>`,
      foot: `<span>${escapeHtml(view.explain.limit)}</span>`
    })}

    ${panel({
      label: "Preserve · what can be handed to someone else",
      title: "Incident Capsule",
      meta: source("simulated", "SIMULATED EVIDENCE"),
      body: `<p class="fl-body fl-prose">${escapeHtml(view.story.preserve)}</p>
        <dl class="fl-kv fl-mt-3">
          <div><dt>Reference</dt><dd><code>${escapeHtml(view.preserve.capsuleId)}</code></dd></div>
          <div><dt>Integrity</dt><dd><code>${escapeHtml(view.preserve.integrity?.algorithm || "sha256")}:${escapeHtml((view.preserve.integrity?.digest || "").slice(0, 24))}…</code></dd></div>
          <div><dt>Attachments</dt><dd>${view.preserve.attachments.length} isolation run</dd></div>
        </dl>
        <div class="fl-state-actions fl-state-actions-start fl-mt-3">
          <a class="fl-btn fl-btn-primary fl-btn-sm" href="${escapeHtml(view.preserve.htmlPath)}" target="_blank" rel="noopener">Open the capsule</a>
          <a class="fl-btn fl-btn-sm" href="${escapeHtml(view.preserve.jsonPath)}" target="_blank" rel="noopener">Capsule JSON</a>
        </div>`,
      foot: `<span>One self-contained file. It never depends on the Analyst, a network connection or a Faultline install to read — the evidence is the product.</span>`
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Render + wiring
// ---------------------------------------------------------------------------

function render() {
  if (!host) return;
  const openView = openInvestigation ? investigationCache.get(openInvestigation) : null;

  host.innerHTML = `
    ${hero()}
    ${resultSection()}
    ${capabilityColumns()}
    ${incidentCards()}
    ${openView ? investigationSection(openView) : ""}
    ${panel({
      label: "Running Faultline yourself",
      title: "What the hosted demo is not",
      body: `<p class="fl-body fl-prose">
          Faultline is local-first. The full product runs on the network being investigated, where it can
          watch adapters, routes, resolvers and the VPN, keep a rolling Flight Recorder buffer, and run
          Network Bisect against a live fault. This deployment demonstrates the parts that make sense from
          a server on the public Internet, and replays the rest.
        </p>
        <dl class="fl-kv fl-mt-3">
          <div><dt>Storage here</dt><dd>${escapeHtml(capabilities?.persistenceNote || "ephemeral")}</dd></div>
          <div><dt>Rate limits</dt><dd>${capabilities?.demo?.rateLimit ? `${capabilities.demo.rateLimit.perClientPerMinute}/min per visitor · best-effort, per instance` : "—"}</dd></div>
          <div><dt>Target policy</dt><dd>Allowlisted public hostnames · ports 80 and 443 only</dd></div>
          <div><dt>Cloud AI</dt><dd>${badge("None, anywhere", "ok")}</dd></div>
        </dl>`,
      foot: `<span>Operator surfaces — cases, registered probes, unrestricted diagnostics — stay behind the admin credential on this deployment and are not part of the demo.</span>`
    })}`;
}

async function runDiagnostic(target) {
  if (running) return;
  running = true;
  render();

  const statusLine = host.querySelector("#demo-status");
  const button = host.querySelector("#demo-run");
  if (button) { button.disabled = true; button.textContent = "Running…"; }
  if (statusLine) {
    statusLine.dataset.tone = "info";
    statusLine.textContent = `Measuring ${target} from ${vantageLabel()} — DNS, TCP, TLS, HTTP, then public vantages.`;
  }

  try {
    lastRun = await api("/api/demo/diagnose", { method: "POST", body: JSON.stringify({ target }) });
    running = false;
    render();
    const line = host.querySelector("#demo-status");
    if (line) {
      line.dataset.tone = "ok";
      line.textContent = `Completed in ${Math.max(0, Date.parse(lastRun.completedAt) - Date.parse(lastRun.startedAt))} ms.`;
    }
    host.querySelector("#demo-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    running = false;
    render();
    const line = host.querySelector("#demo-status");
    if (line) {
      line.dataset.tone = error.status === 429 ? "warn" : "error";
      line.textContent = error.message;
    }
  } finally {
    running = false;
  }
}

async function toggleInvestigation(slug) {
  if (openInvestigation === slug) {
    openInvestigation = null;
    render();
    return;
  }

  if (investigationCache.has(slug)) {
    openInvestigation = slug;
    render();
    host.querySelector(".fl-demo-investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  loadingInvestigation = slug;
  render();
  try {
    investigationCache.set(slug, await api(`/api/demo/incidents/${encodeURIComponent(slug)}`));
    openInvestigation = slug;
  } catch (error) {
    openInvestigation = null;
    loadingInvestigation = null;
    render();
    const line = host.querySelector("#demo-status");
    if (line) { line.dataset.tone = "error"; line.textContent = error.message; }
    return;
  }
  loadingInvestigation = null;
  render();
  host.querySelector(".fl-demo-investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

let started = false;
async function start() {
  if (!host || started) return;
  started = true;
  render();

  try {
    const [caps, list] = await Promise.all([
      api("/api/demo/capabilities"),
      api("/api/demo/incidents")
    ]);
    capabilities = caps;
    incidents = list.incidents || [];
  } catch {
    // Capability detail is a nicety; the hero and the run button still work.
    capabilities = runtime.capabilities;
  }
  render();
}

if (host) {
  host.addEventListener("click", event => {
    const chip = event.target.closest("[data-target]");
    if (chip) {
      const input = host.querySelector("#demo-target");
      if (input) input.value = chip.dataset.target;
      return;
    }
    const replay = event.target.closest("[data-replay]");
    if (replay) void toggleInvestigation(replay.dataset.replay);
  });

  host.addEventListener("submit", event => {
    if (!event.target.matches("#demo-form")) return;
    event.preventDefault();
    const value = host.querySelector("#demo-target")?.value?.trim();
    if (value) void runDiagnostic(value);
  });

  onView("demo", () => void start());
}

void runtime.load();
