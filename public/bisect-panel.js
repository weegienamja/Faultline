// Network Bisect dashboard panel.
//
// Presents the same evidence the CLI prints: every row is a real connection
// attempt, and the verdict distinguishes an isolated condition from an
// unconfirmed one, an intermittent baseline and a target property.

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = `
  .bisect-panel{margin-bottom:13px;border-color:rgba(122,170,255,.3)}
  .bisect-form{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:stretch}
  .bisect-form input[type=text]{flex:1 1 280px;min-width:200px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);padding:11px 12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}
  .bisect-form input[type=text]:focus{border-color:rgba(122,170,255,.5)}
  .bisect-form label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}
  .bisect-form input[type=number]{width:56px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:9px;font:11px ui-monospace,monospace;outline:none}
  .bisect-status{margin:12px 0 0;color:var(--muted);font-size:11px;line-height:1.55;min-height:16px}
  .bisect-status.error{color:var(--danger)}
  .bisect-table{width:100%;border-collapse:collapse;margin-top:14px;font-size:11px}
  .bisect-table th{text-align:left;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em;padding:0 8px 7px 0;font-weight:600}
  .bisect-table td{padding:7px 8px 7px 0;border-top:1px solid var(--border-soft);vertical-align:top}
  .bisect-table tr.baseline td{background:rgba(255,255,255,.02)}
  .bisect-table .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#adc0ba;font-size:10px}
  .bpill{border-radius:999px;padding:3px 8px;font-size:8px;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--border);color:var(--muted);white-space:nowrap;display:inline-block}
  .bpill.pass{color:var(--accent);border-color:rgba(97,230,184,.4);background:var(--accent-soft)}
  .bpill.fail{color:var(--danger);border-color:rgba(255,122,104,.36);background:rgba(255,122,104,.06)}
  .bpill.flaky{color:var(--warn);border-color:rgba(241,184,91,.36);background:rgba(241,184,91,.07)}
  .bpill.inapplicable{color:#5f7670}
  .bverdict{border:1px solid rgba(122,170,255,.32);border-radius:11px;padding:15px;background:rgba(122,170,255,.06);margin-top:16px}
  .bverdict h3{margin:5px 0 8px;font-size:16px}
  .bverdict p{margin:0 0 8px;color:#bbcbc6;font-size:11px;line-height:1.6}
  .bverdict .claim{color:#8fb6ff;font-weight:600}
  .bverdict.isolated{border-color:rgba(97,230,184,.35);background:var(--accent-soft)}
  .bverdict.isolated .claim{color:var(--accent)}
  .bverdict.intermittent,.bverdict.unstable{border-color:rgba(241,184,91,.35);background:rgba(241,184,91,.06)}
  .bseq{font-family:ui-monospace,monospace;font-size:10px;color:#adc0ba;letter-spacing:.14em}
  .bnote{color:#617871;font-size:9px;line-height:1.55;margin-top:10px;border-top:1px solid var(--border-soft);padding-top:9px}
  @media(max-width:700px){.bisect-table .hide-sm{display:none}}
  `;
  document.head.appendChild(style);
}

installStyles();

const anchor = document.getElementById("live-diagnostic") || document.querySelector(".incident-strip");
const panel = document.createElement("section");
panel.className = "panel bisect-panel";
panel.id = "network-bisect";
panel.innerHTML = `
  <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <span class="section-label">CONDITION ISOLATION</span>
      <h3 style="margin:4px 0 0">Network Bisect</h3>
      <p style="margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.55;max-width:74ch">
        Varies one network condition at a time &mdash; address family, DNS resolver, resolved address,
        source interface, TLS version, ALPN, SNI, port &mdash; and finds the smallest change that
        reproducibly flips the result. Nothing on this machine is reconfigured; every condition is
        applied per connection.
      </p>
    </div>
    <span class="src-badge src-local">LOCAL</span>
  </div>

  <form class="bisect-form" id="bisect-form">
    <input type="text" id="bisect-target" placeholder="example.com · 1.1.1.1 · https://example.com/health"
           autocomplete="off" spellcheck="false" value="example.com" />
    <label>repeat <input type="number" id="bisect-repeat" min="1" max="10" value="3" /></label>
    <label>confirm <input type="number" id="bisect-confirm" min="1" max="10" value="3" /></label>
    <button class="primary-button" type="submit" id="bisect-run">Bisect</button>
  </form>
  <p class="bisect-status" id="bisect-status"></p>
  <div id="bisect-results"></div>
`;
anchor?.parentNode?.insertBefore(panel, anchor.nextSibling);

const form = panel.querySelector("#bisect-form");
const targetInput = panel.querySelector("#bisect-target");
const repeatInput = panel.querySelector("#bisect-repeat");
const confirmInput = panel.querySelector("#bisect-confirm");
const runButton = panel.querySelector("#bisect-run");
const statusLine = panel.querySelector("#bisect-status");
const results = panel.querySelector("#bisect-results");

function token() {
  return sessionStorage.getItem("faultlineAdminToken") || "";
}

function renderTable(report) {
  const rows = report.conditions.map(row => {
    const isBaseline = row.axisId === "__baseline__";
    return `<tr class="${isBaseline ? "baseline" : ""}">
      <td><strong>${escapeHtml(isBaseline ? "baseline" : row.axisLabel)}</strong></td>
      <td class="mono">${escapeHtml(row.label)}</td>
      <td><span class="bpill ${escapeHtml(row.outcome)}">${escapeHtml(row.outcome)}</span></td>
      <td class="mono">${escapeHtml(row.passes)}/${escapeHtml(row.total)}</td>
      <td class="mono hide-sm">${escapeHtml(row.stage ? `${row.stage}: ` : "")}${escapeHtml(row.reason || "")}</td>
    </tr>`;
  }).join("");

  return `<table class="bisect-table">
    <thead><tr><th>Condition</th><th>Variant</th><th>Result</th><th>n</th><th class="hide-sm">Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderVerdict(report) {
  const v = report.verdict;
  const banner = {
    isolated: "CONDITION ISOLATED",
    unconditional: "NOT CONDITION-SPECIFIC",
    intermittent: "INTERMITTENT BASELINE",
    unstable: "UNCONFIRMED",
    healthy: "NO FAULT REPRODUCED",
    "not-published": "TARGET PROPERTY, NOT A LOCAL FAULT"
  }[v.kind] || v.kind;

  const conf = report.confirmation;
  const sequence = conf
    ? conf.sequence.map(s => `${s.arm === "baseline" ? "A" : "B"}${s.verdict === "pass" ? "+" : "-"}`).join(" ")
    : null;

  return `<div class="bverdict ${escapeHtml(v.kind)}">
    <span class="section-label">${escapeHtml(banner)}</span>
    <h3>${escapeHtml(v.headline)}</h3>
    <p>${escapeHtml(v.detail)}</p>
    ${v.claim ? `<p class="claim">${escapeHtml(v.claim)}</p>` : ""}
    ${v.recommendation ? `<p>${escapeHtml(v.recommendation)}</p>` : ""}
    ${v.alsoDiffering?.length ? `<p><strong>Other conditions that also differed:</strong><br>${v.alsoDiffering.map(escapeHtml).join("<br>")}</p>` : ""}
    ${v.expectedDifferences?.length ? `<p><strong>Expected differences (not a fault):</strong><br>${v.expectedDifferences.map(escapeHtml).join("<br>")}</p>` : ""}
    ${sequence ? `<p><strong>Interleaved confirmation</strong> (A = baseline, B = ${escapeHtml(conf.label)})<br>
       <span class="bseq">${escapeHtml(sequence)}</span><br>
       ${conf.confirmed ? "Difference held under alternation." : "Difference did NOT hold under alternation."}</p>` : ""}
    <p class="bnote">${escapeHtml(report.trialCount)} real connection attempts across ${escapeHtml(report.axesTested.length)} condition axes.
    ${escapeHtml(report.evidence.note)}</p>
  </div>`;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const target = targetInput.value.trim();
  if (!target) return;
  if (!token()) {
    statusLine.classList.add("error");
    statusLine.textContent = "Unlock live data with the Faultline admin credential first. (The CLI needs no credential: npm run bisect -- " + target + ")";
    document.getElementById("auth-open")?.click();
    return;
  }

  runButton.disabled = true;
  statusLine.classList.remove("error");
  results.innerHTML = "";
  const repeat = Number(repeatInput.value) || 3;
  const confirmPairs = Number(confirmInput.value) || 3;
  statusLine.textContent = `Running controlled trials (${repeat} per condition, ${confirmPairs} confirmation pairs). This makes many real connections and can take a minute…`;

  try {
    const response = await fetch("/api/bisect", {
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ target, repeat, confirmPairs })
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error || `Faultline returned HTTP ${response.status}.`);

    results.innerHTML = renderVerdict(report) + renderTable(report);
    statusLine.textContent = `${report.trialCount} connection attempts across ${report.axesTested.length} axes, completed ${new Date(report.completedAt).toLocaleTimeString()}.`;
  } catch (error) {
    statusLine.classList.add("error");
    statusLine.textContent = error.message;
  } finally {
    runButton.disabled = false;
  }
});
