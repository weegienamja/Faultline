if (location.pathname === "/case-room" || location.pathname === "/case-room/") {
  const TOKEN_KEY = "faultlineCaseRoomToken";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function consumeFragmentToken() {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("token");
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      history.replaceState(null, "", location.pathname);
    }
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  const token = consumeFragmentToken();
  document.title = "Faultline · Incident Room";
  document.body.innerHTML = `<main style="max-width:1050px;margin:0 auto;padding:32px 20px"><div class="panel"><span class="section-label">CROSS-PARTY INCIDENT ROOM</span><h1 style="font-size:28px;margin:6px 0">Shared network evidence</h1><p id="room-status" style="color:var(--muted)">Loading scoped case access…</p><div id="room-content"></div></div></main>`;

  const status = document.getElementById("room-status");
  const content = document.getElementById("room-content");

  async function request(path, options = {}) {
    if (!token) throw new Error("This incident-room link has no participant credential.");
    const response = await fetch(path, {
      method: options.method || "GET",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
    return payload;
  }

  function render(payload) {
    const room = payload.case;
    const participant = payload.participant;
    status.textContent = `${participant.name} · ${participant.organization} · ${participant.role} access · expires ${new Date(participant.expiresAt).toLocaleString()}`;
    const conclusions = room.evidence?.evidence?.deterministic || [];
    content.innerHTML = `
      <section style="margin-top:22px"><span class="section-label">${escapeHtml(room.id)}</span><h2>${escapeHtml(room.title)}</h2><p style="color:var(--muted)">${escapeHtml(room.affectedService)} · ${escapeHtml(room.severity)} · ${escapeHtml(room.status)}</p></section>
      <section class="panel" style="margin-top:14px"><span class="section-label">DETERMINISTIC CONCLUSIONS</span>${conclusions.length ? conclusions.map(item => `<div style="padding:10px 0;border-bottom:1px solid var(--border-soft)"><strong>${escapeHtml(item.sessionId)}</strong><div style="color:var(--muted);margin-top:4px">${escapeHtml(item.diagnosis?.faultDomain || "inconclusive")} · confidence ${escapeHtml(item.diagnosis?.confidence ?? "n/a")}</div></div>`).join("") : '<p style="color:var(--muted)">No completed diagnostic evidence yet.</p>'}</section>
      <section class="panel" style="margin-top:14px"><span class="section-label">CASE TIMELINE</span><ol>${(room.timeline || []).slice().reverse().map(item => `<li style="margin:8px 0"><strong>${escapeHtml(item.type)}</strong> · ${escapeHtml(item.summary)} <small style="color:var(--muted)">${escapeHtml(item.evidenceKind)}</small></li>`).join("")}</ol></section>
      <section class="panel" style="margin-top:14px"><span class="section-label">PARTICIPANT CONTRIBUTIONS</span><div id="contributions">${(room.contributions || []).map(item => `<div style="padding:10px 0;border-bottom:1px solid var(--border-soft)"><strong>${escapeHtml(item.organization)} · ${escapeHtml(item.kind)}</strong><p>${escapeHtml(item.summary)}</p></div>`).join("") || '<p style="color:var(--muted)">No external contributions yet.</p>'}</div>${participant.role === "contributor" ? `<form id="contribution-form" style="margin-top:14px;display:grid;gap:10px"><label>Contribution type<select id="contribution-kind"><option value="observation">Observation</option><option value="counter-evidence">Counter-evidence</option><option value="question">Question</option><option value="resolution-update">Resolution update</option></select></label><label>Evidence or comment<textarea id="contribution-summary" required rows="5" maxlength="2400" placeholder="Describe what your side observed. Include measurements where useful, but do not paste credentials or sensitive content."></textarea></label><button class="primary-button" type="submit">Add to shared case</button><p id="contribution-error" style="color:var(--muted)"></p></form>` : '<p style="color:var(--muted)">This participant has read-only access.</p>'}</section>
      <section class="panel" style="margin-top:14px"><span class="section-label">SHARED EVIDENCE SCOPE</span><p style="color:var(--muted)">The shared evidence package is redacted for local network identifiers. Observed measurements, inferred topology, deterministic conclusions and statistical evidence remain separate classes.</p></section>`;

    document.getElementById("contribution-form")?.addEventListener("submit", async event => {
      event.preventDefault();
      const error = document.getElementById("contribution-error");
      try {
        await request("/api/case-room/contributions", { method: "POST", body: {
          kind: document.getElementById("contribution-kind").value,
          summary: document.getElementById("contribution-summary").value
        }});
        await load();
      } catch (err) { error.textContent = err.message; }
    });
  }

  async function load() {
    try { render(await request("/api/case-room")); }
    catch (error) { status.textContent = error.message; content.innerHTML = '<p style="color:var(--muted)">Ask the case owner for a new scoped invitation if this link has expired or been revoked.</p>'; }
  }

  load();
}
