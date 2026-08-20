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
  document.body.innerHTML = `<main class="fl-room">
    <section class="fl-panel">
      <header class="fl-panel-head">
        <div>
          <span class="fl-label">Cross-party incident room</span>
          <h1 class="fl-page-title">Shared network evidence</h1>
        </div>
      </header>
      <div class="fl-panel-body">
        <p class="fl-body" id="room-status">Loading scoped case access…</p>
      </div>
    </section>
    <div id="room-content" class="fl-stack"></div>
  </main>`;

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
    // Evidence classes stay separated here exactly as they are in the main
    // application: a deterministic conclusion Faultline reached is framed as
    // one, and a partner's written contribution is framed as an account rather
    // than as a measurement.
    content.innerHTML = `
      <section class="fl-panel">
        <header class="fl-panel-head">
          <div>
            <span class="fl-label"><span class="fl-value">${escapeHtml(room.id)}</span></span>
            <h2 class="fl-panel-title">${escapeHtml(room.title)}</h2>
          </div>
        </header>
        <div class="fl-panel-body">
          <p class="fl-body">${escapeHtml(room.affectedService)} · ${escapeHtml(room.severity)} · ${escapeHtml(room.status)}</p>
        </div>
      </section>

      <section class="fl-panel">
        <header class="fl-panel-head">
          <div>
            <span class="fl-label">Deterministic conclusions</span>
            <h2 class="fl-panel-title">What Faultline established</h2>
          </div>
          <div class="fl-panel-head-actions">
            <span class="fl-provenance" data-evidence="deterministic">Deterministic</span>
          </div>
        </header>
        <div class="fl-panel-body">
          ${conclusions.length
            ? `<div class="fl-evidence-set">${conclusions.map(item => `
                <div class="fl-evidence" data-evidence="deterministic">
                  <div class="fl-evidence-head">
                    <h3 class="fl-evidence-title"><span class="fl-value">${escapeHtml(item.sessionId)}</span></h3>
                  </div>
                  <p class="fl-body">${escapeHtml(item.diagnosis?.faultDomain || "inconclusive")} · confidence ${escapeHtml(item.diagnosis?.confidence ?? "n/a")}</p>
                </div>`).join("")}</div>`
            : `<p class="fl-body">No completed diagnostic evidence yet.</p>`}
        </div>
      </section>

      <section class="fl-panel">
        <header class="fl-panel-head">
          <div>
            <span class="fl-label">Case timeline</span>
            <h2 class="fl-panel-title">What happened, in order</h2>
          </div>
        </header>
        <div class="fl-panel-body">
          <ol class="fl-timeline">${(room.timeline || []).slice().reverse().map(item => `
            <li class="fl-tl-item">
              <span class="fl-tl-when">${escapeHtml(item.evidenceKind)}</span>
              <span class="fl-tl-rail"><span class="fl-tl-node"></span></span>
              <div class="fl-tl-body">
                <p class="fl-tl-title">${escapeHtml(item.type)}</p>
                <p class="fl-tl-why">${escapeHtml(item.summary)}</p>
              </div>
            </li>`).join("")}</ol>
        </div>
      </section>

      <section class="fl-panel">
        <header class="fl-panel-head">
          <div>
            <span class="fl-label">Participant contributions</span>
            <h2 class="fl-panel-title">What the other parties reported</h2>
          </div>
          <div class="fl-panel-head-actions">
            <span class="fl-provenance" data-evidence="interpretation">Reported</span>
          </div>
        </header>
        <div class="fl-panel-body">
          <div id="contributions" class="fl-evidence-set">${(room.contributions || []).map(item => `
            <div class="fl-evidence" data-evidence="interpretation">
              <div class="fl-evidence-head">
                <h3 class="fl-evidence-title">${escapeHtml(item.organization)} · ${escapeHtml(item.kind)}</h3>
              </div>
              <p class="fl-body">${escapeHtml(item.summary)}</p>
            </div>`).join("") || `<p class="fl-body">No external contributions yet.</p>`}</div>
          ${participant.role === "contributor" ? `
            <form id="contribution-form" class="fl-stack fl-mt-3">
              <label class="fl-field">
                <span class="fl-label">Contribution type</span>
                <select class="fl-select" id="contribution-kind">
                  <option value="observation">Observation</option>
                  <option value="counter-evidence">Counter-evidence</option>
                  <option value="question">Question</option>
                  <option value="resolution-update">Resolution update</option>
                </select>
              </label>
              <label class="fl-field">
                <span class="fl-label">Evidence or comment</span>
                <textarea class="fl-textarea" id="contribution-summary" required rows="5" maxlength="2400"
                  placeholder="Describe what your side observed. Include measurements where useful, but do not paste credentials or sensitive content."></textarea>
              </label>
              <div class="fl-row">
                <button class="fl-btn fl-btn-primary" type="submit">Add to shared case</button>
                <p class="fl-status-line" id="contribution-error" data-tone="error"></p>
              </div>
            </form>`
            : `<p class="fl-body fl-mt-3">This participant has read-only access.</p>`}
        </div>
      </section>

      <section class="fl-panel">
        <header class="fl-panel-head">
          <div>
            <span class="fl-label">Shared evidence scope</span>
            <h2 class="fl-panel-title">What this link exposes</h2>
          </div>
        </header>
        <div class="fl-panel-body">
          <p class="fl-body fl-prose">The shared evidence package is redacted for local network identifiers. Observed measurements, inferred topology, deterministic conclusions and statistical evidence remain separate classes.</p>
        </div>
      </section>`;

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
    catch (error) { status.textContent = error.message; content.innerHTML = '<p class="fl-body">Ask the case owner for a new scoped invitation if this link has expired or been revoked.</p>'; }
  }

  load();
}
