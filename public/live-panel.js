// Live diagnostic panel — the primary "test something real" surface.
//
// Every value rendered here comes from a real measurement or a real public API
// response returned by /api/live/diagnostics. Nothing is simulated. Each block
// carries an explicit source badge so LIVE/LOCAL/PUBLIC-INTERNET data can never
// be confused with the DEMO scenarios.

const SOURCE_LABELS = {
  local: "LOCAL",
  live: "LIVE",
  ripestat: "RIPESTAT",
  globalping: "GLOBALPING",
  atlas: "RIPE ATLAS",
  ioda: "IODA",
  peeringdb: "PEERINGDB",
  radar: "CLOUDFLARE RADAR",
  deterministic: "DETERMINISTIC",
  inferred: "INFERRED",
  demo: "DEMO"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function badge(kind, extra = "") {
  const label = SOURCE_LABELS[kind] || String(kind).toUpperCase();
  return `<span class="src-badge src-${escapeHtml(kind)}">${escapeHtml(label)}${extra ? ` · ${escapeHtml(extra)}` : ""}</span>`;
}

function value(v, fallback = "unknown") {
  if (v === null || v === undefined || v === "") return `<em class="unset">${escapeHtml(fallback)}</em>`;
  return escapeHtml(v);
}

function ms(v) {
  return Number.isFinite(Number(v)) ? `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} ms` : null;
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = `
  .live-panel{margin-bottom:13px;border-color:var(--fl-ok-line)}
  .live-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
  .live-form{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:stretch}
  .live-form input[type=text]{flex:1 1 300px;min-width:220px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);padding:11px 12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}
  .live-form input[type=text]:focus{border-color:var(--fl-ok-line)}
  .live-form button{white-space:nowrap}
  .live-modes{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  .live-mode{border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--muted);padding:6px 11px;font-size:10px;cursor:pointer}
  .live-mode.active{border-color:var(--fl-ok-line);color:var(--accent);background:var(--accent-soft)}
  .live-status{margin:12px 0 0;color:var(--muted);font-size:11px;line-height:1.55;min-height:16px}
  .live-status.error{color:var(--danger)}
  .src-badge{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:3px 7px;font-size:8px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
  .src-live,.src-local,.src-deterministic{border-color:var(--fl-ok-line);color:var(--accent);background:var(--accent-soft)}
  .src-ripestat,.src-globalping,.src-atlas,.src-ioda,.src-peeringdb,.src-radar{border-color:var(--fl-accent-line);color:var(--fl-accent);background:var(--fl-accent-soft)}
  .src-inferred{border-color:rgba(241,184,91,.36);color:var(--warn);background:rgba(241,184,91,.07)}
  .src-demo{border-color:rgba(139,160,154,.35);color:var(--fl-text-2);background:rgba(139,160,154,.06)}
  .live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px;margin-top:16px}
  .live-card{border:1px solid var(--border-soft);border-radius:11px;padding:14px;background:rgba(255,255,255,.012);min-width:0}
  .live-card h4{margin:0 0 3px;font-size:12px}
  .live-card-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:10px}
  .live-card .note{color:var(--fl-text-3);font-size:9px;line-height:1.5;margin:9px 0 0}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:11px}
  .kv dt{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.07em;align-self:center}
  .kv dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
  .unset{color:var(--fl-text-3);font-style:normal}
  .stage-row,.res-row,.van-row{display:grid;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--border-soft);font-size:11px}
  .stage-row{grid-template-columns:52px 1fr auto}
  .res-row{grid-template-columns:1fr auto auto}
  .van-row{grid-template-columns:1fr auto auto}
  .stage-row:first-of-type,.res-row:first-of-type,.van-row:first-of-type{border-top:0}
  .pill{border-radius:999px;padding:3px 7px;font-size:8px;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
  .pill.pass{color:var(--accent);border-color:var(--fl-ok-line);background:var(--accent-soft)}
  .pill.fail{color:var(--danger);border-color:rgba(255,122,104,.36);background:rgba(255,122,104,.06)}
  .pill.warn{color:var(--warn);border-color:rgba(241,184,91,.36);background:rgba(241,184,91,.07)}
  .pill.na{color:var(--fl-text-3)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--fl-text-2)}
  .hop-list{max-height:230px;overflow:auto;margin:0;padding:0;list-style:none}
  .hop{display:grid;grid-template-columns:26px 1fr auto;gap:8px;padding:6px 0;border-top:1px solid var(--border-soft);font-size:10px;align-items:center}
  .hop:first-child{border-top:0}
  .hop small{color:var(--muted);display:block;font-size:9px}
  .verdict{border:1px solid var(--fl-ok-line);border-radius:11px;padding:14px;background:var(--accent-soft);margin-top:16px}
  .verdict h3{margin:4px 0 6px;font-size:17px}
  .verdict p{margin:0;color:#bbcbc6;font-size:11px;line-height:1.55}
  .src-list{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
  .disclaimer{color:var(--fl-text-3);font-size:9px;line-height:1.55;margin:12px 0 0;border-top:1px solid var(--border-soft);padding-top:10px}
  .env-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
  .manifest-box{margin-top:11px}
  .manifest-box textarea{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);padding:10px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;min-height:130px;outline:none}
  @media(max-width:760px){.live-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

// --------------------------------------------------------------------------
// Panel construction
// --------------------------------------------------------------------------

installStyles();

// Mounted into the Live Diagnostics view rather than located by probing the
// DOM for a neighbouring element.
const anchor = document.querySelector('[data-mount="live"]') || document.querySelector(".incident-strip");
const panel = document.createElement("section");
panel.className = "panel live-panel";
panel.id = "live-diagnostic";
panel.innerHTML = `
  <div class="live-head">
    <div>
      <span class="section-label">REAL NETWORK EVIDENCE</span>
      <h3 style="margin:4px 0 0">Test a real target</h3>
      <p style="margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.55;max-width:70ch">
        Runs genuine DNS, TCP, TLS, HTTP, ICMP and path measurements from this machine, then adds public routing,
        outage and network-ownership context. Everything below is measured or retrieved live. The
        <span class="src-badge src-demo">sample</span> incidents on the Overview remain synthetic.
      </p>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
      ${badge("local")}${badge("live")}${badge("ripestat")}${badge("globalping")}${badge("ioda")}${badge("peeringdb")}
    </div>
  </div>

  <div class="live-modes" id="live-modes">
    <button class="live-mode active" type="button" data-mode="public">Test a public service</button>
    <button class="live-mode" type="button" data-mode="device">Test this device</button>
    <button class="live-mode" type="button" data-mode="environment">Load my environment</button>
  </div>

  <form class="live-form" id="live-form">
    <input type="text" id="live-target" placeholder="example.com · 1.1.1.1 · https://example.com/health" autocomplete="off" spellcheck="false" value="example.com" />
    <button class="primary-button" type="submit" id="live-run">Run live diagnostic</button>
  </form>
  <p class="live-status" id="live-status"></p>

  <div id="live-environment" hidden>
    <div class="env-actions">
      <button class="secondary-button" type="button" id="env-sample">Insert example manifest</button>
      <button class="secondary-button" type="button" id="env-preview">Preview manifest</button>
      <button class="primary-button" type="button" id="env-activate">Activate environment</button>
    </div>
    <div class="manifest-box">
      <textarea id="env-manifest" spellcheck="false" placeholder='{"version":1,"sites":[...],"targets":[...]}'></textarea>
    </div>
    <div id="env-result"></div>
  </div>

  <div id="live-results"></div>
`;
if (anchor?.dataset?.mount) anchor.appendChild(panel);
else anchor?.parentNode?.insertBefore(panel, anchor);

const form = panel.querySelector("#live-form");
const targetInput = panel.querySelector("#live-target");
const runButton = panel.querySelector("#live-run");
const statusLine = panel.querySelector("#live-status");
const results = panel.querySelector("#live-results");
const modes = panel.querySelector("#live-modes");
const envBlock = panel.querySelector("#live-environment");
const envManifest = panel.querySelector("#env-manifest");
const envResult = panel.querySelector("#env-result");

let mode = "public";

function token() {
  return sessionStorage.getItem("faultlineAdminToken") || "";
}

async function api(path, { method = "GET", body } = {}) {
  if (!token()) {
    const error = new Error("Unlock live data with the Faultline admin credential to run a live diagnostic.");
    error.status = 401;
    throw error;
  }
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

// --------------------------------------------------------------------------
// Renderers — each block states its own source
// --------------------------------------------------------------------------

function renderStages(result) {
  const rows = result.observed.stages.map(s => {
    const cls = s.state === "pass" ? "pass" : s.state === "fail" ? "fail" : "na";
    const timing = ms(s.ms);
    return `<div class="stage-row">
      <strong>${escapeHtml(s.name)}</strong>
      <span class="mono">${escapeHtml(s.detail || "")}</span>
      <span><span class="pill ${cls}">${escapeHtml(s.state)}</span>${timing ? ` <span class="mono">${escapeHtml(timing)}</span>` : ""}</span>
    </div>`;
  }).join("");

  const tls = result.observed.tls;
  const cert = tls?.certificate;
  const certBlock = tls?.ok && cert ? `
    <dl class="kv" style="margin-top:11px">
      <dt>TLS</dt><dd>${value(tls.protocol)} · ${value(tls.cipher)}</dd>
      <dt>Subject</dt><dd>${value(cert.subject)}</dd>
      <dt>Issuer</dt><dd>${value(cert.issuer)}</dd>
      <dt>Expires</dt><dd>${value(cert.validTo)}${cert.daysRemaining != null ? ` <span class="mono">(${cert.daysRemaining} days)</span>` : ""}</dd>
      <dt>Chain</dt><dd>${tls.chainTrusted ? "trusted by system CA store" : `<span class="pill fail">not trusted</span> ${escapeHtml(tls.chainError || "")}`}</dd>
    </dl>` : "";

  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Connection stages</h4><span class="mono">${escapeHtml(result.target.host)}:${escapeHtml(result.target.port)}</span></div>${badge("local")}</div>
    ${rows}${certBlock}
  </article>`;
}

function renderDns(result) {
  const dns = result.observed.dns;
  if (!dns.measured) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>DNS resolvers</h4></div>${badge("local")}</div>
      <p class="note">${escapeHtml(dns.reason || "Not measured.")}</p></article>`;
  }
  const sys = dns.system.a;
  const rows = [
    `<div class="res-row"><div><strong>System resolver</strong><br><span class="mono">${escapeHtml((dns.systemResolvers || []).join(", ") || "unknown")}</span></div>
      <span class="pill ${sys.ok ? "pass" : "fail"}">${sys.ok ? "pass" : "fail"}</span>
      <span class="mono">${escapeHtml(ms(sys.elapsedMs) || "-")}</span></div>
     <div class="res-row" style="border-top:0;padding-top:0"><span class="mono" style="grid-column:1/-1;color:var(--fl-text-2)">${escapeHtml(sys.ok ? sys.addresses.join(", ") : sys.error || "no answer")}</span></div>`,
    ...dns.comparisons.map(c => `<div class="res-row"><div><strong>${escapeHtml(c.label)}</strong></div>
      <span class="pill ${c.ok ? "pass" : "fail"}">${c.ok ? "pass" : "fail"}</span>
      <span class="mono">${escapeHtml(ms(c.elapsedMs) || "-")}</span></div>
      <div class="res-row" style="border-top:0;padding-top:0"><span class="mono" style="grid-column:1/-1;color:var(--fl-text-2)">${escapeHtml(c.ok ? c.addresses.join(", ") : c.error || "no answer")}</span></div>`)
  ].join("");

  const agree = dns.agreement;
  const agreePill = agree.state === "consistent" ? '<span class="pill pass">consistent</span>'
    : agree.state === "divergent" ? '<span class="pill warn">divergent</span>'
      : '<span class="pill na">not compared</span>';

  return `<article class="live-card">
    <div class="live-card-head"><div><h4>DNS resolvers</h4><span class="mono">A records · ${escapeHtml(result.target.host)}</span></div>${badge("local")}</div>
    ${rows}
    <dl class="kv" style="margin-top:11px">
      <dt>Agreement</dt><dd>${agreePill}${agree.state === "divergent" ? ` <span class="mono">${agree.distinctAnswers} distinct answers</span>` : ""}</dd>
      <dt>AAAA</dt><dd>${dns.system.aaaa.ok ? escapeHtml(dns.system.aaaa.addresses.join(", ")) : `<em class="unset">${escapeHtml(dns.system.aaaa.error || "no AAAA")}</em>`}</dd>
      <dt>Authoritative NS</dt><dd>${dns.system.authoritativeNs.length ? escapeHtml(dns.system.authoritativeNs.join(", ")) : `<em class="unset">${escapeHtml(dns.system.nsError || "unknown")}</em>`}</dd>
    </dl>
    ${agree.state === "divergent" ? '<p class="note">Resolvers returned different answers. This is evidence worth investigating, not proof that any resolver is faulty.</p>' : ""}
  </article>`;
}

function renderRouting(result) {
  const ctx = result.internetContext;
  if (!ctx || !ctx.enriched) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>Target network</h4></div>${badge("ripestat")}</div>
      <p class="note">${escapeHtml(ctx?.reason || "No public routing context available.")}</p></article>`;
  }
  const r = ctx.routing;
  if (!r) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>Target network</h4></div>${badge("ripestat")}</div>
      <p class="note">RIPEstat did not return routing information for this address.</p></article>`;
  }
  const rpkiPill = r.rpkiStatus === "valid" ? "pass" : r.rpkiStatus === "invalid" ? "fail" : "na";
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Target network</h4><span class="mono">routing &amp; ownership context</span></div>${badge("ripestat")}</div>
    <dl class="kv">
      <dt>Resolved IP</dt><dd>${value(r.ip)}</dd>
      <dt>Prefix</dt><dd>${value(r.prefix)}</dd>
      <dt>Origin ASN</dt><dd>${r.originAsn != null ? `AS${escapeHtml(r.originAsn)}` : `<em class="unset">unknown</em>`}</dd>
      <dt>Network owner</dt><dd>${value(r.asnName)}</dd>
      <dt>RPKI</dt><dd><span class="pill ${rpkiPill}">${escapeHtml(r.rpkiStatus || "unknown")}</span>${r.rpkiValidator ? ` <span class="mono">${escapeHtml(r.rpkiValidator)}</span>` : ""}</dd>
      <dt>RIS visibility</dt><dd>${r.visibility ? `${escapeHtml(r.visibility.risPeersSeeing)}/${escapeHtml(r.visibility.risPeersTotal)} peers <span class="mono">(${escapeHtml(r.visibility.percent)}%)</span>` : `<em class="unset">unknown</em>`}</dd>
    </dl>
    <p class="note">NETWORK OWNER and ROUTING CONTEXT only. This is not a Faultline fault-domain decision &mdash; IP ownership is not fault ownership.</p>
  </article>`;
}

function renderRoutingActivity(result) {
  const activity = result.internetContext?.routingActivity;
  if (!activity) return "";
  const quiet = activity.announcements === 0 && activity.withdrawals === 0;
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Routing activity</h4><span class="mono">last ${escapeHtml(activity.windowHours)}h · ${escapeHtml(activity.prefix)}</span></div>${badge("ripestat")}</div>
    <dl class="kv">
      <dt>Announcements</dt><dd>${escapeHtml(activity.announcements)}</dd>
      <dt>Withdrawals</dt><dd>${escapeHtml(activity.withdrawals)}</dd>
      <dt>Updates seen</dt><dd>${escapeHtml(activity.totalReported)}</dd>
    </dl>
    <p class="note">${quiet
      ? "No BGP update activity observed for this prefix in the window."
      : "Route activity observed near this diagnostic. Correlation only &mdash; this does not establish that routing caused the fault."}</p>
  </article>`;
}

function renderVantages(result) {
  const d = result.distributed;
  if (d.status !== "ok") {
    const reason = d.reason || d.error || "unavailable";
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>Public Internet vantages</h4></div>${badge("globalping")}</div>
      <p class="note">${escapeHtml(reason)}</p></article>`;
  }
  const rows = d.data.vantages.map(v => {
    const pill = v.status === "finished" && (v.lossPct === null || v.lossPct < 100) ? "pass" : "fail";
    return `<div class="van-row">
      <div><strong>${escapeHtml(v.location)}</strong><br><span class="mono">${v.asn ? `AS${escapeHtml(v.asn)}` : ""} ${escapeHtml(v.network || "")}</span></div>
      <span class="mono">${escapeHtml(ms(v.latencyMs) || "-")}</span>
      <span class="pill ${pill}">${escapeHtml(v.lossPct === null ? v.status : `${v.lossPct}% loss`)}</span>
    </div>`;
  }).join("");
  const s = d.data.summary;
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Public Internet vantages</h4><span class="mono">${escapeHtml(s.reachable)}/${escapeHtml(s.total)} reachable${d.cached ? " · cached" : ""}</span></div>${badge("globalping")}</div>
    ${rows}
    <p class="note">Real ICMP measurements from independent public probes. These are OBSERVED remote evidence and do feed the deterministic second-vantage comparison.</p>
  </article>`;
}

function renderOutage(result) {
  const ctx = result.internetContext;
  const outage = ctx?.outageContext;
  const radarConfigured = ctx?.radarConfigured;
  const radarLine = radarConfigured
    ? (ctx?.radar ? `${ctx.radar.count} annotation(s)` : "no annotations")
    : "Not configured";
  if (!outage) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>External outage context</h4></div>${badge("ioda")}</div>
      <p class="note">No IODA context available for this target.</p>
      <dl class="kv" style="margin-top:9px"><dt>Cloudflare Radar</dt><dd>${escapeHtml(radarLine)}</dd></dl></article>`;
  }
  const anomalies = Object.entries(outage.scopes || {}).map(([scope, data]) => {
    if (!data.available) return `<div class="res-row"><div><strong>${escapeHtml(scope)}</strong></div><span class="pill na">unavailable</span><span></span></div>`;
    const pill = data.anomalyCount > 0 ? (data.highestLevel === "critical" ? "fail" : "warn") : "pass";
    return `<div class="res-row"><div><strong>${escapeHtml(scope === "asn" ? `Target ASN${outage.asn ? ` AS${outage.asn}` : ""}` : `Country ${outage.countryCode || ""}`)}</strong></div>
      <span class="pill ${pill}">${data.anomalyCount > 0 ? escapeHtml(`${data.anomalyCount} signal(s)`) : "none detected"}</span><span></span></div>`;
  }).join("");

  return `<article class="live-card">
    <div class="live-card-head"><div><h4>External outage context</h4><span class="mono">last ${escapeHtml(outage.windowHours)}h</span></div>${badge("ioda")}</div>
    ${anomalies}
    <dl class="kv" style="margin-top:11px"><dt>Cloudflare Radar</dt><dd>${escapeHtml(radarLine)}</dd></dl>
    <p class="note">${escapeHtml(outage.summary)} Potentially relevant external signal only &mdash; Faultline never treats an outage feed as proof of the cause of this fault.</p>
  </article>`;
}

function renderNetworkMetadata(result) {
  const meta = result.internetContext?.networkMetadata;
  if (!meta) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>Network metadata</h4></div>${badge("peeringdb")}</div>
      <p class="note">No PeeringDB record published for this network.</p></article>`;
  }
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Network metadata</h4><span class="mono">self-published</span></div>${badge("peeringdb")}</div>
    <dl class="kv">
      <dt>Network</dt><dd>${value(meta.name)}</dd>
      <dt>ASN</dt><dd>${meta.asn != null ? `AS${escapeHtml(meta.asn)}` : `<em class="unset">unknown</em>`}</dd>
      <dt>Type</dt><dd>${value(meta.networkType)}</dd>
      <dt>Scope</dt><dd>${value(meta.scope)}</dd>
      <dt>Peering</dt><dd>${value(meta.peeringPolicy)}</dd>
      <dt>IX presence</dt><dd>${meta.exchangeCount != null ? `${escapeHtml(meta.exchangeCount)} exchanges` : `<em class="unset">unknown</em>`}</dd>
    </dl>
    ${meta.exchanges?.length ? `<p class="mono" style="margin:9px 0 0">${escapeHtml(meta.exchanges.slice(0, 4).map(e => e.name).join(" · "))}</p>` : ""}
    <p class="note">NETWORK METADATA, not OBSERVED PATH. Faultline has no evidence that this diagnostic traversed any listed exchange or facility.</p>
  </article>`;
}

function renderAtlas(result) {
  const network = result.internetContext?.measurementNetwork;
  if (!network) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>RIPE Atlas context</h4></div>${badge("atlas")}</div>
      <p class="note">No RIPE Atlas context available.</p></article>`;
  }
  const scopes = Object.entries(network.scopes || {}).map(([scope, data]) => {
    if (!data.available) return `<div class="res-row"><div><strong>${escapeHtml(scope)}</strong></div><span class="pill na">unavailable</span><span></span></div>`;
    const label = scope === "targetAsn" ? `Probes in target ASN${network.asn ? ` AS${network.asn}` : ""}` : `Probes in ${network.countryCode || "region"}`;
    const sample = data.probes.slice(0, 3).map(p => `#${p.id}${p.asn ? ` AS${p.asn}` : ""}${p.countryCode ? ` ${p.countryCode}` : ""}`).join(" · ");
    return `<div class="res-row"><div><strong>${escapeHtml(label)}</strong><br><span class="mono">${escapeHtml(sample || "none")}</span></div>
      <span class="pill ${data.total > 0 ? "pass" : "na"}">${escapeHtml(data.total)} connected</span><span></span></div>`;
  }).join("");
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>RIPE Atlas context</h4><span class="mono">measurement network</span></div>${badge("atlas")}</div>
    ${scopes}
    <p class="note">${escapeHtml(network.note)}</p>
  </article>`;
}

function renderLocal(result) {
  const l = result.observed.local;
  if (!l.supported) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>This device</h4></div>${badge("local")}</div>
      <dl class="kv"><dt>Host</dt><dd>${value(l.host)}</dd><dt>Platform</dt><dd>${value(l.platform)}</dd>
      <dt>Resolvers</dt><dd>${escapeHtml((l.resolvers || []).join(", ") || "unknown")}</dd></dl>
      <p class="note">${escapeHtml(l.reason || "")}</p></article>`;
  }
  const gw = result.observed.gatewayPing;
  const wifi = l.wifi || {};
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>This device</h4><span class="mono">${escapeHtml(l.host)}</span></div>${badge("local")}</div>
    <dl class="kv">
      <dt>Interface</dt><dd>${value(l.interfaceAlias)}</dd>
      <dt>Local IPv4</dt><dd>${value(l.ipv4?.address)}${l.ipv4?.prefixLength ? `/${escapeHtml(l.ipv4.prefixLength)}` : ""}</dd>
      <dt>Local IPv6</dt><dd>${value(l.ipv6?.address, "none")}</dd>
      <dt>Gateway</dt><dd>${value(l.gateway)}</dd>
      <dt>Gateway RTT</dt><dd>${gw?.measured ? `${escapeHtml(ms(gw.averageMs) || "no reply")} · ${escapeHtml(gw.lossPct)}% loss` : `<em class="unset">${escapeHtml(gw?.reason || "not measured")}</em>`}</dd>
      <dt>Wi-Fi</dt><dd>${wifi.connected ? `${escapeHtml(wifi.ssid || "unknown SSID")} · ${escapeHtml(wifi.signalPct ?? "?")}%${wifi.channel ? ` · ch ${escapeHtml(wifi.channel)}` : ""}` : `<em class="unset">not connected / wired</em>`}</dd>
      <dt>VPN</dt><dd>${l.vpn?.active ? escapeHtml(l.vpn.adapters.map(a => a.name).join(", ")) : `<em class="unset">no VPN adapter up</em>`}</dd>
      <dt>DNS servers</dt><dd>${escapeHtml((l.resolvers || []).join(", ") || "unknown")}</dd>
      <dt>Internet</dt><dd><span class="pill ${l.internetReachable ? "pass" : "fail"}">${l.internetReachable ? "reachable" : "unreachable"}</span></dd>
    </dl>
    <p class="note">Local network facts are never sent to any third-party API.</p>
  </article>`;
}

function renderPath(result) {
  const path = result.observed.path || [];
  if (!path.length) {
    return `<article class="live-card">
      <div class="live-card-head"><div><h4>Observed path</h4></div>${badge("local")}</div>
      <p class="note">${escapeHtml(result.observed.traceroute.reason || "No traceroute hops were collected.")}</p></article>`;
  }
  const rows = path.map(hop => {
    const owner = hop.enrichment === "enriched"
      ? `${hop.asn ? `AS${hop.asn}` : ""} ${hop.network || ""}`.trim()
      : hop.enrichment === "skipped-private" ? "private / local hop — not enriched"
        : hop.enrichment === "unavailable" ? "ownership lookup unavailable"
          : hop.ip ? "not enriched" : "no response";
    return `<li class="hop">
      <span class="mono">${escapeHtml(hop.hop)}</span>
      <div><span class="mono">${escapeHtml(hop.ip || "* * *")}</span><small>${escapeHtml(owner)}</small></div>
      <span class="mono">${escapeHtml(ms(hop.averageRttMs) || "-")}</span>
    </li>`;
  }).join("");
  return `<article class="live-card">
    <div class="live-card-head"><div><h4>Observed path</h4><span class="mono">${escapeHtml(path.length)} hops · public hops enriched</span></div>${badge("local")} ${badge("ripestat")}</div>
    <ul class="hop-list">${rows}</ul>
    <p class="note">Hop addresses are OBSERVED. Owner/ASN labels are PUBLIC ROUTING METADATA for the hop address, not proof of who operates the failing segment.</p>
  </article>`;
}

function renderVerdict(result) {
  const d = result.deterministic.diagnosis;
  const sources = (result.internetContext?.sources || []).map(s => {
    const state = s.status === "ok" ? (s.cached ? "cached" : "live") : s.status;
    return badge(s.name.replace("-activity", "").replace("ripe-atlas", "atlas").replace("cloudflare-radar", "radar"), state);
  });
  return `<div class="verdict">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div>
        <span class="section-label">DETERMINISTIC FAULT DOMAIN</span>
        <h3>${escapeHtml(d.faultDomainLabel)}</h3>
        <p>${escapeHtml(d.summary)}</p>
      </div>
      <div style="text-align:right">
        <div style="font-size:26px;font-weight:800;color:var(--accent)">${escapeHtml(d.confidence)}%</div>
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.09em">confidence</div>
      </div>
    </div>
    <div class="src-list">${badge("deterministic")}${badge("local", "measured")}${sources.join("")}</div>
    <p class="disclaimer">The fault domain above is produced only by the deterministic rule engine from observed measurements.
    Routing, RPKI, outage and network-metadata context is supporting evidence and never changes this conclusion.</p>
  </div>`;
}

function render(result) {
  results.innerHTML = `
    ${renderVerdict(result)}
    <div class="live-grid">
      ${renderStages(result)}
      ${renderDns(result)}
      ${renderRouting(result)}
      ${renderVantages(result)}
      ${renderLocal(result)}
      ${renderPath(result)}
      ${renderRoutingActivity(result)}
      ${renderNetworkMetadata(result)}
      ${renderOutage(result)}
      ${renderAtlas(result)}
    </div>
    <p class="disclaimer">${escapeHtml(result.internetContext?.privacy || "")}</p>
  `;
  // Expose the live result so the Network Map / other panels can consume it.
  window.dispatchEvent(new CustomEvent("faultline-live-result", { detail: result }));
}

// --------------------------------------------------------------------------
// Interactions
// --------------------------------------------------------------------------

modes.addEventListener("click", event => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  mode = button.dataset.mode;
  modes.querySelectorAll(".live-mode").forEach(b => b.classList.toggle("active", b === button));
  envBlock.hidden = mode !== "environment";
  form.hidden = mode === "environment";
  if (mode === "device") {
    targetInput.value = "1.1.1.1";
    statusLine.textContent = "Device mode measures this machine's own network path, gateway, Wi-Fi, VPN and DNS while reaching the reference target.";
  } else if (mode === "public") {
    statusLine.textContent = "";
  }
});

// The Environment view links straight to the manifest editor, so it needs to be
// able to select a mode from outside this module.
window.addEventListener("faultline-live-mode", event => {
  const wanted = event.detail?.mode;
  const button = modes.querySelector(`button[data-mode="${wanted}"]`);
  if (button) button.click();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const target = targetInput.value.trim();
  if (!target) return;
  runButton.disabled = true;
  statusLine.classList.remove("error");
  statusLine.textContent = "Running real measurements (DNS, TCP, TLS, HTTP, ICMP, path) and querying public Internet sources…";
  results.innerHTML = "";
  try {
    const result = await api("/api/live/diagnostics", { method: "POST", body: { target, distributed: true, enrich: true } });
    render(result);
    const stamp = new Date(result.completedAt).toLocaleTimeString();
    statusLine.textContent = `Live diagnostic ${result.id} completed at ${stamp}. Resolved ${result.target.host} → ${result.target.resolvedAddress || "no address"}.`;
  } catch (error) {
    statusLine.classList.add("error");
    statusLine.textContent = error.status === 401
      ? "Unlock live data with the Faultline admin credential first, then run the live diagnostic."
      : error.message;
    if (error.status === 401) document.getElementById("auth-open")?.click();
  } finally {
    runButton.disabled = false;
  }
});

const SAMPLE_MANIFEST = {
  version: 1,
  name: "Example environment",
  sites: [{ id: "glasgow", name: "Glasgow Office", location: "Glasgow, UK" }],
  targets: [
    { name: "Customer Portal", url: "https://example.com", scope: "public", contract: "secure-web" },
    { name: "Internal CRM", host: "10.40.12.25", port: 443, scope: "private", site: "glasgow", contract: "secure-web" }
  ]
};

panel.querySelector("#env-sample").addEventListener("click", () => {
  envManifest.value = JSON.stringify(SAMPLE_MANIFEST, null, 2);
});

function renderManifest(data, activated) {
  const rows = data.targets.map(t => `<div class="res-row">
    <div><strong>${escapeHtml(t.name)}</strong><br><span class="mono">${escapeHtml(t.url || `${t.host}:${t.port}`)}${t.site ? ` · ${escapeHtml(t.site)}` : ""}</span></div>
    <span class="pill ${t.scope === "private" ? "warn" : "pass"}">${escapeHtml(t.scope)}</span>
    <span class="pill ${t.runnable === false ? "fail" : "na"}">${escapeHtml(t.requiresPrivateProbe ? (t.runnable === false ? "needs private probe" : "private probe") : "control plane")}</span>
  </div>`).join("");
  envResult.innerHTML = `<article class="live-card" style="margin-top:12px">
    <div class="live-card-head"><div><h4>${escapeHtml(data.name)}</h4>
      <span class="mono">${escapeHtml(data.summary.siteCount)} site(s) · ${escapeHtml(data.summary.targetCount)} target(s) · ${escapeHtml(data.summary.privateTargets)} private</span></div>
      ${badge("local", activated ? "activated" : "preview")}</div>
    ${rows}
    ${(data.notes || []).map(n => `<p class="note">${escapeHtml(n)}</p>`).join("")}
    ${activated && data.privateProbes ? `<p class="note">Registered private probes: ${data.privateProbes.length ? escapeHtml(data.privateProbes.map(p => `${p.name} (${p.health})`).join(", ")) : "none — private targets are blocked until one is registered."}</p>` : ""}
  </article>`;
}

async function submitManifest(path, activated) {
  envResult.innerHTML = "";
  let parsed;
  try { parsed = JSON.parse(envManifest.value); }
  catch { envResult.innerHTML = `<p class="live-status error">Manifest is not valid JSON.</p>`; return; }
  try {
    const data = await api(path, { method: "POST", body: { manifest: parsed } });
    renderManifest(data, activated);
  } catch (error) {
    envResult.innerHTML = `<p class="live-status error">${escapeHtml(error.message)}</p>`;
    if (error.status === 401) document.getElementById("auth-open")?.click();
  }
}

panel.querySelector("#env-preview").addEventListener("click", () => submitManifest("/api/environment/manifest/preview", false));
panel.querySelector("#env-activate").addEventListener("click", () => submitManifest("/api/environment/manifest", true));

// Re-enable messaging when the operator unlocks live data.
window.addEventListener("faultline-auth-changed", () => {
  if (token() && statusLine.classList.contains("error")) {
    statusLine.classList.remove("error");
    statusLine.textContent = "Live data unlocked. Run a live diagnostic against a real target.";
  }
});
