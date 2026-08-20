// Faultline application shell.
//
// Two jobs, deliberately kept small:
//
//   1. Routing. The dashboard used to be one long scroll with anchor links, so
//      every surface competed for the same screen and "where am I" had no
//      answer. Views are now real destinations addressable by URL.
//   2. Shared primitives. Panels previously each injected a <style> block and
//      invented their own colours and markup. The helpers below are the only
//      sanctioned way to render a badge, tile, state or panel frame.

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
// ONE place decides whether this is a hosted public demo or an operator's own
// control plane. Ten modules each sniffing for a hostname would drift, and the
// consequence of drift here is a panel telling a visitor that Faultline read
// their Wi-Fi from a server in London.
//
// The synchronous half comes from attributes the server stamps onto <html>
// when it serves the page, so the FIRST paint is already correct and there is
// no flash of the wrong surface. The full capability document is fetched once
// afterwards for the detail panels.

const runtimeState = {
  capabilities: null,
  error: null
};

export const runtime = {
  get isHosted() { return document.documentElement.dataset.runtime === "hosted"; },
  get isPublicDemo() { return document.documentElement.dataset.publicDemo === "true"; },
  /** The label a measurement taken by this deployment may carry. Never "LOCAL" when hosted. */
  get vantageLabel() { return document.documentElement.dataset.vantageLabel || "LOCAL"; },
  get vantageRegion() { return document.documentElement.dataset.vantageRegion || ""; },
  get capabilities() { return runtimeState.capabilities; },

  /** Resolves with the capability document, or null if it could not be read. */
  async load() {
    if (runtimeState.capabilities || runtimeState.error) return runtimeState.capabilities;
    try {
      const response = await fetch("/api/capabilities", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      runtimeState.capabilities = await response.json();
      window.dispatchEvent(new CustomEvent("faultline-runtime", { detail: runtimeState.capabilities }));
    } catch (error) {
      runtimeState.error = error;
    }
    return runtimeState.capabilities;
  }
};

/**
 * Runtime-dependent wording, in one place.
 *
 * Several panels have to describe the admin credential, and on a hosted public
 * demo every one of them was telling a visitor to "unlock live data" - an
 * instruction they cannot follow and should not want to. Rather than teaching
 * each panel about hosting, they ask here for the sentence that is true of the
 * runtime they are in.
 */
export const words = {
  /** The topbar / call-to-action label for the credential dialog. */
  get unlockAction() { return runtime.isPublicDemo ? "Operator sign-in" : "Unlock live data"; },
  get unlockedAction() { return runtime.isPublicDemo ? "Operator session" : "Live data unlocked"; },
  /** The rail's credential indicator. */
  get railLocked() { return runtime.isPublicDemo ? "Public demo" : "Live data locked"; },
  get railUnlocked() { return runtime.isPublicDemo ? "Operator session" : "Live data unlocked"; },
  /** One sentence explaining why a gated surface is gated. */
  lockedBody(what) {
    return runtime.isPublicDemo
      ? `${what} belongs to the Faultline control plane an operator runs on their own network. The hosted demo does not expose it.`
      : `${what} requires the Faultline admin credential. It is held in this browser tab only and never persisted.`;
  },
  /** The button that follows `lockedBody`. */
  get lockedAction() {
    return runtime.isPublicDemo
      ? `<button class="fl-btn fl-btn-primary" data-goto="demo">Open the hosted demo</button>`
      : `<button class="fl-btn fl-btn-primary" data-action="unlock">Unlock live data</button>`;
  },
  /**
   * Where a measurement this deployment takes actually comes from.
   *
   * Panels used to hard-code "Measured locally", which is true of an operator's
   * own install and a lie on a hosted one. They ask here instead.
   */
  get measuredHere() { return runtime.isHosted ? runtime.vantageLabel : "Measured locally"; },
  /** The machine a local install is running on, named in a way hosting cannot make false. */
  get thisMachine() { return runtime.isHosted ? "the machine running Faultline" : "this machine"; }
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------
// Every status in the product maps onto exactly four visual states. Panels must
// translate their domain vocabulary here rather than picking a colour directly,
// which is what kept PASS green in one panel and mint in another.

const STATUS_BY_TERM = {
  pass: "ok", ok: "ok", healthy: "ok", online: "ok", up: "ok", resolved: "ok",
  supported: "ok", improvement: "ok", isolated: "ok",

  warn: "warn", warning: "warn", degraded: "warn", stale: "warn", unstable: "warn",
  weakened: "warn", intermittent: "warn", partial: "warn", unconfirmed: "warn",

  fail: "crit", failed: "crit", critical: "crit", offline: "crit", down: "crit",
  error: "crit", regression: "crit", breaking: "crit",

  idle: "idle", unknown: "idle", inapplicable: "idle", unsupported: "idle",
  contradicted: "idle", disabled: "idle", "not_testable": "idle", skipped: "idle"
};

export function statusOf(term) {
  if (!term) return "idle";
  return STATUS_BY_TERM[String(term).trim().toLowerCase().replace(/\s+/g, "_")] || "idle";
}

// ---------------------------------------------------------------------------
// Render helpers — all return HTML strings so panels can compose them freely
// ---------------------------------------------------------------------------

export function badge(text, status = "idle", { code = false } = {}) {
  const cls = code ? "fl-badge fl-badge-code" : "fl-badge";
  return `<span class="${cls}" data-status="${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

/** Machine state (PASS / FAIL / INAPPLICABLE …) rendered in the code style. */
export function stateBadge(term) {
  return badge(String(term ?? "—").replace(/_/g, " "), statusOf(term), { code: true });
}

export function dot(status = "idle") {
  return `<span class="fl-dot" data-status="${escapeHtml(status)}"></span>`;
}

/** Where a number came from: measured | inferred | external | simulated. */
export function source(kind, label = kind) {
  return `<span class="fl-source" data-kind="${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

export function tile({ label, value, unit, sub, status = "idle" }) {
  // Figures get the numeral treatment; phrases step down so a long fault-domain
  // name does not shout louder than the measurements next to it.
  const kind = /^[\d.,+\-−]+$/.test(String(value).trim()) ? "number" : "text";
  return `<div class="fl-tile" data-status="${escapeHtml(status)}">
    <span class="fl-tile-label">${escapeHtml(label)}</span>
    <span class="fl-tile-value" data-kind="${kind}">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</span>
    ${sub ? `<span class="fl-tile-sub">${sub}</span>` : ""}
  </div>`;
}

export function panel({ label, title, meta = "", body, foot = "", status, flush = false, id = "" }) {
  return `<section class="fl-panel"${status ? ` data-status="${escapeHtml(status)}"` : ""}${id ? ` id="${escapeHtml(id)}"` : ""}>
    <header class="fl-panel-head">
      <div>
        ${label ? `<span class="fl-label">${escapeHtml(label)}</span>` : ""}
        <h2 class="fl-panel-title">${escapeHtml(title)}</h2>
      </div>
      ${meta ? `<div class="fl-panel-head-actions">${meta}</div>` : ""}
    </header>
    <div class="fl-panel-body${flush ? " fl-panel-body-flush" : ""}">${body}</div>
    ${foot ? `<footer class="fl-panel-foot">${foot}</footer>` : ""}
  </section>`;
}

/**
 * Empty / error / locked state.
 *
 * Faultline has a lot of surfaces that are legitimately empty until someone
 * runs something. An empty surface must say what it will contain and how to
 * fill it, otherwise it reads as broken.
 */
export function state({ icon = "○", title, body, actions = "", tone = "empty" }) {
  return `<div class="fl-state" data-tone="${escapeHtml(tone)}">
    <div class="fl-state-icon" aria-hidden="true">${icon}</div>
    <p class="fl-state-title">${escapeHtml(title)}</p>
    ${body ? `<p class="fl-state-body">${escapeHtml(body)}</p>` : ""}
    ${actions ? `<div class="fl-state-actions">${actions}</div>` : ""}
  </div>`;
}

export function skeleton(rows = 4) {
  return `<div class="fl-skeleton-rows">${Array.from({ length: rows }, () => `<div class="fl-skeleton"></div>`).join("")}</div>`;
}

export function disclose(summary, body, { open = false } = {}) {
  return `<details class="fl-disclose"${open ? " open" : ""}>
    <summary>${escapeHtml(summary)}</summary>
    <div class="fl-disclose-body">${body}</div>
  </details>`;
}

/** Horizontal bar list — used where a count comparison beats a time series. */
export function bars(rows) {
  const max = Math.max(1, ...rows.map(r => Number(r.value) || 0));
  return `<div class="fl-bars">${rows.map(r => `
    <div class="fl-bar-row">
      <span>${escapeHtml(r.label)}</span>
      <span class="fl-bar-track"><span class="fl-bar-fill" data-status="${escapeHtml(r.status || "info")}" style="width:${Math.round((Number(r.value) || 0) / max * 100)}%"></span></span>
      <span class="fl-bar-value">${escapeHtml(r.display ?? r.value)}</span>
    </div>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Mount points
// ---------------------------------------------------------------------------
// Panels used to locate themselves with `insertBefore` against whatever element
// happened to be nearby, so layout depended on script import order. They now
// ask for a named slot declared in the markup.

export function mount(name) {
  return document.querySelector(`[data-mount="${name}"]`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const views = new Map();
let activeView = null;

function readViews() {
  for (const node of document.querySelectorAll("[data-view]")) {
    views.set(node.dataset.view, {
      node,
      title: node.dataset.viewTitle || node.dataset.view,
      group: node.dataset.viewGroup || ""
    });
  }
}

/**
 * The landing surface.
 *
 * On a hosted public demo, Overview is the wrong first screen: it reports on a
 * collected incident, and a hosted deployment has none, so a visitor's first
 * impression would be an empty workspace asking for a credential. The demo view
 * is what the product can actually do here, so it is the default.
 */
function defaultView() {
  return runtime.isPublicDemo && views.has("demo") ? "demo" : "overview";
}

function routeFromHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  return views.has(raw) ? raw : defaultView();
}

/**
 * Switch views, with a cross-fade where the browser can do one cheaply.
 *
 * Views are `display: none` siblings, so a switch is instantaneous and the
 * whole screen changes at once — which reads as a flicker rather than as
 * navigation. A short cross-fade says "this replaced that" without costing
 * troubleshooting time.
 *
 * Three conditions, all of which must hold, or it falls straight through to
 * the plain swap:
 *   - the browser has the API at all;
 *   - the user has not asked for reduced motion;
 *   - this is not the first render (there is nothing to transition FROM, and
 *     animating the initial paint would delay first contentful paint).
 */
function apply(name) {
  const view = views.get(name);
  if (!view || activeView === name) return;

  const animate = activeView !== null
    && typeof document.startViewTransition === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (animate) document.startViewTransition(() => swap(name, view));
  else swap(name, view);
}

function swap(name, view) {
  activeView = name;

  for (const [key, entry] of views) entry.node.classList.toggle("is-active", key === name);

  for (const link of document.querySelectorAll(".fl-nav-item")) {
    const target = (link.getAttribute("href") || "").replace(/^#\/?/, "");
    if (target === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  const crumbGroup = document.getElementById("crumb-group");
  const crumbTitle = document.getElementById("crumb-title");
  if (crumbGroup) crumbGroup.textContent = view.group;
  if (crumbTitle) crumbTitle.textContent = view.title;
  document.title = `${view.title} · Faultline`;

  document.querySelector(".fl-content")?.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0 });

  // Panels render lazily so an unopened view costs nothing.
  window.dispatchEvent(new CustomEvent("faultline-view", { detail: { view: name } }));
}

export function currentView() {
  return activeView;
}

export function goTo(name) {
  if (location.hash === `#/${name}`) apply(name);
  else location.hash = `#/${name}`;
}

/** Run `fn` the first time `name` becomes visible, and on every visit after. */
export function onView(name, fn) {
  if (activeView === name) fn();
  window.addEventListener("faultline-view", event => {
    if (event.detail.view === name) fn();
  });
}

function start() {
  readViews();
  // The brand mark is the one control every visitor tries. On a public demo it
  // pointed at Overview - an operator archive that is locked here - so clicking
  // the logo from the demo landed on "Live data is locked". It goes where the
  // deployment's own front door is instead.
  if (runtime.isPublicDemo) {
    const brand = document.querySelector(".fl-brand");
    if (brand) {
      brand.setAttribute("href", "#/demo");
      brand.setAttribute("aria-label", "Faultline hosted demo");
    }
  }
  apply(routeFromHash());
  window.addEventListener("hashchange", () => apply(routeFromHash()));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

// ---------------------------------------------------------------------------
// Credential state, shared across panels
// ---------------------------------------------------------------------------

export const auth = {
  get token() { return sessionStorage.getItem("faultlineAdminToken") || ""; },
  get unlocked() { return Boolean(this.token); },
  set(value) {
    if (value) sessionStorage.setItem("faultlineAdminToken", value);
    else sessionStorage.removeItem("faultlineAdminToken");
    window.dispatchEvent(new CustomEvent("faultline-auth-changed"));
  },
  /**
   * Standard locked-surface state, so every gated panel reads identically.
   *
   * On the hosted demo the honest message is different. This is not a surface
   * the visitor is one credential away from using: it is an operator control
   * plane for a Faultline someone runs themselves, and telling a recruiter to
   * "unlock live data" on a public demo is a dead end. So it says what the
   * surface is for, and points at the thing they CAN do.
   */
  lockedState(what) {
    return state({
      icon: "◌",
      tone: "locked",
      title: runtime.isPublicDemo ? "Operator surface" : "Live data is locked",
      body: words.lockedBody(what),
      actions: words.lockedAction
    });
  },
  /**
   * Ask for the credential, but ONLY where asking is a route the person can take.
   *
   * A public visitor cannot hold the operator's admin token, so putting that
   * dialog in front of them turns an ordinary click into "I need the
   * developer's password to use this" - the single impression this demo most
   * has to avoid. On a public demo the panel's own inline explanation is the
   * whole answer and nothing is prompted.
   *
   * Returns true when the dialog was opened, so callers can branch.
   */
  promptUnlock() {
    if (runtime.isPublicDemo) return false;
    document.getElementById("auth-open")?.click();
    return true;
  }
};

document.addEventListener("click", event => {
  if (event.target.closest("[data-action='unlock']")) document.getElementById("auth-open")?.click();
  // The rail's Explain entry drives the one Analyst toggle rather than owning a
  // second copy of the drawer's open/close state.
  if (event.target.closest("[data-opens='analyst']")) document.getElementById("analyst-toggle")?.click();
});
