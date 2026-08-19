// Network bisect API.
//
// Admin-authenticated for the same reason as the live diagnostic routes: a
// bisect run makes many real outbound connections, so an open endpoint would
// be an SSRF and resource-abuse primitive.
//
// The CLI (`npm run bisect`) needs none of this and is the primary entry point.

import { bisect } from "./engine.mjs";
import { isolate } from "./adaptive.mjs";
import { assertLiteralTargetAllowed } from "../security/target.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { EVIDENCE_KIND, evidenceRegistry } from "../analyst/registry.mjs";

const MAX_REPEAT = 10;
const MAX_CONFIRM = 10;

export function createBisectRouter({ requireAdmin, bodyFrom, json }) {
  return async function handleBisect(req, res, url) {
    if (!url.pathname.startsWith("/api/bisect")) return false;
    requireAdmin(req);

    if (req.method === "POST" && url.pathname === "/api/bisect") {
      const payload = await bodyFrom(req);
      if (!payload.target) {
        const error = new Error("A target hostname, IP address or URL is required.");
        error.statusCode = 400;
        throw error;
      }

      // Same public-target safety boundary as every other outbound path.
      const target = parseLiveTarget(String(payload.target), payload.port);
      const scope = payload.scope === "private" ? "private" : "public";
      assertLiteralTargetAllowed(target.input, target.port, scope);

      const clamp = (value, fallback, max) => {
        const numeric = Number(value ?? fallback);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) return fallback;
        return numeric;
      };

      const shared = {
        repeat: clamp(payload.repeat, 3, MAX_REPEAT),
        confirmPairs: clamp(payload.confirmPairs, 3, MAX_CONFIRM),
        timeoutMs: Math.min(Math.max(Number(payload.timeoutMs) || 5_000, 500), 30_000)
      };

      // Adaptive planning is the default; "exhaustive" runs the full matrix.
      const report = payload.mode === "exhaustive"
        ? await bisect(target.input, { ...shared, includeSourceInterface: payload.includeSourceInterface !== false })
        : await isolate(target.input, { ...shared, maxExperiments: clamp(payload.maxExperiments, 12, 40) });

      // Retained in memory only, so the Analyst can be asked about the run
      // that was just produced. Nothing is written to disk.
      const runId = evidenceRegistry.record(EVIDENCE_KIND.BISECT, report);

      json(res, 201, { ...report, id: report.id || runId });
      return true;
    }

    return false;
  };
}
