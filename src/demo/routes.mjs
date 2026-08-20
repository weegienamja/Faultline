// Public demo API.
//
// UNAUTHENTICATED, and the only such router in Faultline that causes outbound
// network activity. That is a deliberate, narrow exception to the rule the
// live, bisect, recorder and analyst routers follow, and it is safe only
// because of what sits behind it:
//
//   * /api/demo/diagnose runs a CONSTRAINED diagnostic. It cannot name an
//     address, a port other than 80/443, a scheme other than http(s), or a
//     host outside a fixed allowlist, and it never executes a local command.
//     See src/demo/policy.mjs.
//   * /api/demo/incidents serves REPLAYS. They make no outbound connection at
//     all - they are recorded scenarios driven through the production engines.
//   * Every route is rate limited and time budgeted. See src/demo/limits.mjs.
//
// The existing admin surfaces are untouched. Nothing here reads or writes the
// Faultline store, so a public visitor cannot see or affect an operator's
// cases, probes, sessions or captured incidents.
//
// The whole router is mounted only when the runtime says this deployment is a
// public demo. On a local install with no demo flag these paths do not exist.

import { capabilities, isPublicDemo } from "../runtime/capabilities.mjs";
import { runDemoDiagnostic } from "./diagnose.mjs";
import { getInvestigation, listInvestigations, projectInvestigation, renderInvestigationCapsule } from "./investigations.mjs";
import { clientKey, createDemoLimiter } from "./limits.mjs";
import { DEMO_ALLOWED_PORTS, readAllowlist } from "./policy.mjs";

/** Slug or reference in a path segment. Bounded, and never used as a path. */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,48}$/;

export function createDemoRouter({
  bodyFrom,
  json,
  env = process.env,
  limiter = createDemoLimiter(),
  runDiagnostic = runDemoDiagnostic
} = {}) {
  const enabled = isPublicDemo(env);
  const allowlist = readAllowlist(env);

  function demoCapabilities() {
    return {
      ...capabilities(env),
      demo: {
        enabled: true,
        liveDiagnostic: {
          path: "/api/demo/diagnose",
          method: "POST",
          allowedPorts: [...DEMO_ALLOWED_PORTS],
          allowlist,
          allowlistOnly: true,
          literalAddresses: false,
          note: "The hosted demo probes a fixed set of public services. Hostnames are resolved and every returned address is validated as globally routable before any connection is made, and each redirect hop is re-checked the same way."
        },
        recordedIncidents: listInvestigations(),
        rateLimit: limiter.describe()
      }
    };
  }

  return async function handleDemo(req, res, url) {
    if (!url.pathname.startsWith("/api/demo")) return false;
    // Not a public-demo deployment: these routes simply do not exist, and the
    // server's API 404 answers instead of this router.
    if (!enabled) return false;

    // --- capability + policy description -----------------------------------
    if (req.method === "GET" && (url.pathname === "/api/demo" || url.pathname === "/api/demo/capabilities")) {
      json(res, 200, demoCapabilities());
      return true;
    }

    // --- recorded investigations -------------------------------------------
    //
    // No outbound network activity, so no rate limit beyond the platform's own.
    if (req.method === "GET" && url.pathname === "/api/demo/incidents") {
      json(res, 200, { incidents: listInvestigations() });
      return true;
    }

    const capsuleMatch = url.pathname.match(/^\/api\/demo\/incidents\/([^/]+)\/capsule$/);
    if (req.method === "GET" && capsuleMatch) {
      const reference = decodeURIComponent(capsuleMatch[1]);
      assertReference(reference);
      const investigation = await getInvestigation(reference);

      if (url.searchParams.get("format") === "json") {
        json(res, 200, investigation.capsule);
        return true;
      }

      const html = renderInvestigationCapsule(investigation);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${investigation.capsuleFilename}"`
      });
      res.end(html);
      return true;
    }

    const incidentMatch = url.pathname.match(/^\/api\/demo\/incidents\/([^/]+)$/);
    if (req.method === "GET" && incidentMatch) {
      const reference = decodeURIComponent(incidentMatch[1]);
      assertReference(reference);
      json(res, 200, projectInvestigation(await getInvestigation(reference)));
      return true;
    }

    // --- the live hosted diagnostic ----------------------------------------
    if (url.pathname === "/api/demo/diagnose") {
      if (req.method !== "POST") {
        const error = new Error("The public demo diagnostic accepts POST.");
        error.statusCode = 405;
        throw error;
      }

      const release = limiter.acquire(clientKey(req));
      try {
        const payload = await bodyFrom(req);
        if (!payload || typeof payload !== "object") {
          const error = new Error("A JSON body with a target is required.");
          error.statusCode = 400;
          throw error;
        }

        const result = await runDiagnostic(String(payload.target ?? ""), {
          allowlist,
          vantages: payload.vantages,
          // A caller may turn optional enrichment OFF (faster, fewer external
          // calls) but may not turn anything ON that policy does not already
          // permit. There is no caller-controlled destination here at all.
          distributed: payload.distributed !== false,
          enrich: payload.enrich !== false
        });

        json(res, 201, result);
        return true;
      } finally {
        release();
      }
    }

    // Any other /api/demo path is a 404 from this router rather than falling
    // through to the SPA HTML fallback.
    const error = new Error(`No Faultline public demo route matches ${req.method} ${url.pathname}.`);
    error.statusCode = 404;
    throw error;
  };

  function assertReference(value) {
    if (!REFERENCE.test(String(value))) {
      const error = new Error("Invalid recorded investigation reference.");
      error.statusCode = 400;
      throw error;
    }
  }
}
