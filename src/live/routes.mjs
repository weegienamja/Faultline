// Live diagnostic + environment routes.
//
// AUTHENTICATION: every route here is admin-authenticated. These endpoints make
// real outbound network connections and spawn ping/traceroute, so leaving them
// unauthenticated would hand an SSRF and resource-abuse primitive to anyone who
// can reach the control plane. This matches the existing rule that every
// evidence-generating endpoint is authenticated (/api/diagnose stays public
// only because it is a pure function over supplied metrics).

import { runLiveDiagnostic } from "./diagnostic.mjs";
import { previewManifest, validateManifest } from "../environment/manifest.mjs";
import { PUBLIC_PROBE_ALLOWED_PORTS } from "../security/target.mjs";
import { isConfigured as radarConfigured } from "../integrations/cloudflare-radar.mjs";
import { EVIDENCE_KIND, evidenceRegistry } from "../analyst/registry.mjs";

export function createLiveRouter({ requireAdmin, bodyFrom, json, store, publicProbe }) {
  return async function handleLive(req, res, url) {
    if (!url.pathname.startsWith("/api/live") && !url.pathname.startsWith("/api/environment")) return false;
    requireAdmin(req);

    // Capabilities: lets the dashboard describe what is available without
    // leaking whether a token value is correct.
    if (req.method === "GET" && url.pathname === "/api/live/capabilities") {
      json(res, 200, {
        sources: [
          { id: "local", label: "LOCAL", description: "Measurements taken by this control plane", requiresCredential: false, enabled: true },
          { id: "ripestat", label: "RIPESTAT", description: "Prefix, origin ASN, holder, RPKI, RIS visibility, BGP activity", requiresCredential: false, enabled: true },
          { id: "globalping", label: "GLOBALPING", description: "Live measurements from public vantage points", requiresCredential: false, enabled: true },
          { id: "ripe-atlas", label: "RIPE ATLAS", description: "Public probe context near the target network", requiresCredential: false, enabled: true },
          { id: "ioda", label: "IODA", description: "External outage/anomaly signals", requiresCredential: false, enabled: true },
          { id: "peeringdb", label: "PEERINGDB", description: "Self-published network metadata", requiresCredential: false, enabled: true },
          { id: "cloudflare-radar", label: "CLOUDFLARE RADAR", description: "Optional outage annotations", requiresCredential: true, enabled: radarConfigured() }
        ],
        publicProbePorts: [...PUBLIC_PROBE_ALLOWED_PORTS],
        maxVantages: 5
      });
      return true;
    }

    // Run a real diagnostic against a real target.
    if (req.method === "POST" && url.pathname === "/api/live/diagnostics") {
      const payload = await bodyFrom(req);
      if (!payload.target) {
        const error = new Error("A target hostname, IP address or URL is required.");
        error.statusCode = 400;
        throw error;
      }
      const result = await runLiveDiagnostic({
        target: String(payload.target),
        port: payload.port,
        scope: payload.scope === "private" ? "private" : "public",
        distributed: payload.distributed !== false,
        enrich: payload.enrich !== false,
        traceroute: payload.traceroute !== false,
        vantages: payload.vantages,
        countryCode: payload.countryCode ? String(payload.countryCode).toUpperCase().slice(0, 2) : null
      });
      // Retained in memory only, so the Analyst can answer questions about the
      // diagnostic just run. Nothing is written to disk.
      evidenceRegistry.record(EVIDENCE_KIND.LIVE, result);

      json(res, 201, result);
      return true;
    }

    // Validate + preview a network manifest without activating anything.
    if (req.method === "POST" && url.pathname === "/api/environment/manifest/preview") {
      const payload = await bodyFrom(req);
      json(res, 200, previewManifest(payload.manifest ?? payload));
      return true;
    }

    // Activate a manifest. Private targets are annotated with the probe they
    // need; nothing is executed here.
    if (req.method === "POST" && url.pathname === "/api/environment/manifest") {
      const payload = await bodyFrom(req);
      const manifest = validateManifest(payload.manifest ?? payload);
      const probes = await store.listProbes();
      const privateProbes = probes.filter(probe => (probe.scope || "public") === "private" && probe.enabled !== false && !probe.revokedAt);

      const targets = manifest.targets.map(target => ({
        ...target,
        runnable: target.requiresPrivateProbe ? privateProbes.length > 0 : true,
        blockedReason: target.requiresPrivateProbe && privateProbes.length === 0
          ? "No authorised private probe is registered. Private targets are never measured by a public probe."
          : null
      }));

      json(res, 201, {
        ...manifest,
        targets,
        privateProbes: privateProbes.map(probe => publicProbe(probe)),
        activatedAt: new Date().toISOString(),
        note: "Manifest validated and held in the browser session. Faultline does not persist manifests as a tenant record in this preview."
      });
      return true;
    }

    return false;
  };
}
