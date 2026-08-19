import { analyseIncidents as analyseCore } from "./intelligence.js";

if (typeof window !== "undefined") import("./case-room.js");

export function analyseEvidencePatterns(incidents, options = {}) {
  const evidenceOnly = incidents.map(incident => ({
    ...incident,
    diagnosis: null
  }));
  const result = analyseCore(evidenceOnly, options);
  result.featureSpace = {
    ...result.featureSpace,
    categorical: result.featureSpace.categorical.filter(key => key !== "faultDomain")
  };
  result.method = {
    ...result.method,
    diagnosisFeaturesExcluded: true
  };
  return result;
}
