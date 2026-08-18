const NUMERIC_FEATURES = [
  { key: "gatewayLatencyMs", label: "gateway latency", weight: 1 },
  { key: "gatewayLoss", label: "gateway packet loss", weight: 1.2 },
  { key: "upstreamLoss", label: "upstream packet loss", weight: 1.25 },
  { key: "jitterMs", label: "jitter", weight: 1 },
  { key: "dnsLookupMs", label: "DNS latency", weight: 0.7 },
  { key: "targetTcpMs", label: "target TCP latency", weight: 0.7 },
  { key: "targetHttpMs", label: "target HTTP latency", weight: 0.65 },
  { key: "contractPassRate", label: "contract pass rate", weight: 1.05 },
  { key: "contractFailedRequired", label: "failed contract checks", weight: 1.05 }
];

const BINARY_FEATURES = [
  { key: "dnsResolved", label: "DNS resolution", weight: 1.1 },
  { key: "internetReachable", label: "general Internet reachability", weight: 0.8 },
  { key: "targetReachable", label: "endpoint target reachability", weight: 1.1 },
  { key: "externalProbeHealthy", label: "remote target reachability", weight: 1.15 },
  { key: "vpnRequired", label: "VPN requirement", weight: 0.85 },
  { key: "vpnConnected", label: "VPN connection state", weight: 0.7 },
  { key: "expectedRoutePresent", label: "expected VPN route", weight: 0.8 },
  { key: "contractPassed", label: "Connectivity Contract result", weight: 1.1 }
];

const CATEGORICAL_FEATURES = [
  { key: "faultDomain", label: "fault domain", weight: 1.35 },
  { key: "contractId", label: "Connectivity Contract", weight: 0.75 },
  { key: "contractFailureType", label: "contract failure stage", weight: 0.95 }
];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values, average) {
  if (values.length < 2) return 1;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
  const std = Math.sqrt(variance);
  return std > 1e-9 ? std : 1;
}

function rawIncidentFeatures(incident) {
  const metrics = incident?.metrics || {};
  const contract = incident?.telemetry?.connectivityContract || null;
  const diagnosis = incident?.diagnosis || null;
  return {
    id: incident.id,
    numeric: Object.fromEntries(NUMERIC_FEATURES.map(feature => [feature.key, finite(metrics[feature.key])])),
    binary: Object.fromEntries(BINARY_FEATURES.map(feature => {
      const value = metrics[feature.key];
      return [feature.key, typeof value === "boolean" ? value : null];
    })),
    categorical: {
      faultDomain: diagnosis?.faultDomain || null,
      contractId: contract?.contract?.id || incident?.connectivityContract?.id || null,
      contractFailureType: metrics.contractFailureType || contract?.firstFailureType || null
    }
  };
}

export function fitIncidentFeatureSpace(incidents) {
  const rows = incidents.filter(item => item?.id && item?.metrics).map(rawIncidentFeatures);
  const numeric = {};
  for (const feature of NUMERIC_FEATURES) {
    const observed = rows.map(row => row.numeric[feature.key]).filter(Number.isFinite);
    const fill = median(observed);
    const complete = rows.map(row => row.numeric[feature.key] ?? fill);
    const average = mean(complete);
    numeric[feature.key] = {
      mean: average,
      std: deviation(complete, average),
      median: fill,
      observed: observed.length
    };
  }

  const categories = {};
  for (const feature of CATEGORICAL_FEATURES) {
    const values = new Set(rows.map(row => row.categorical[feature.key] || "none"));
    categories[feature.key] = [...values].sort();
  }

  return {
    rowCount: rows.length,
    numeric,
    categories,
    numericFeatures: NUMERIC_FEATURES.map(({ key, label, weight }) => ({ key, label, weight })),
    binaryFeatures: BINARY_FEATURES.map(({ key, label, weight }) => ({ key, label, weight })),
    categoricalFeatures: CATEGORICAL_FEATURES.map(({ key, label, weight }) => ({ key, label, weight }))
  };
}

function clippedZ(value, stats) {
  const resolved = value ?? stats.median;
  const z = (resolved - stats.mean) / stats.std;
  return Math.max(-3, Math.min(3, z)) / 3;
}

function binaryValue(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return 0.5;
}

export function vectoriseIncident(incident, featureSpace) {
  const raw = rawIncidentFeatures(incident);
  const vector = [];
  const weights = [];
  const names = [];

  for (const feature of NUMERIC_FEATURES) {
    vector.push(clippedZ(raw.numeric[feature.key], featureSpace.numeric[feature.key]));
    weights.push(feature.weight);
    names.push(feature.key);
  }

  for (const feature of BINARY_FEATURES) {
    vector.push(binaryValue(raw.binary[feature.key]));
    weights.push(feature.weight);
    names.push(feature.key);
  }

  for (const feature of CATEGORICAL_FEATURES) {
    const selected = raw.categorical[feature.key] || "none";
    for (const category of featureSpace.categories[feature.key] || ["none"]) {
      vector.push(selected === category ? 1 : 0);
      weights.push(feature.weight);
      names.push(`${feature.key}:${category}`);
    }
  }

  return { id: incident.id, vector, weights, names, raw };
}

export function incidentDistance(left, right) {
  if (!left?.vector || !right?.vector || left.vector.length !== right.vector.length) {
    throw new Error("Incident vectors must use the same fitted feature space.");
  }
  let weighted = 0;
  let totalWeight = 0;
  for (let index = 0; index < left.vector.length; index += 1) {
    const weight = Number(left.weights[index] ?? right.weights[index] ?? 1);
    const delta = left.vector[index] - right.vector[index];
    weighted += (delta * delta) * (weight * weight);
    totalWeight += weight * weight;
  }
  return totalWeight ? Math.sqrt(weighted / totalWeight) : 0;
}

export function similarityFromDistance(distance) {
  const score = Math.exp(-Math.max(0, Number(distance) || 0) * 1.6) * 100;
  return Number(score.toFixed(1));
}

export function dbscan(vectors, { epsilon = 0.34, minPoints = 3 } = {}) {
  const labels = Array(vectors.length).fill(undefined);
  const visited = new Set();
  let cluster = 0;

  const neighbours = index => vectors
    .map((candidate, candidateIndex) => ({
      index: candidateIndex,
      distance: incidentDistance(vectors[index], candidate)
    }))
    .filter(item => item.distance <= epsilon)
    .map(item => item.index);

  for (let index = 0; index < vectors.length; index += 1) {
    if (visited.has(index)) continue;
    visited.add(index);
    const nearby = neighbours(index);
    if (nearby.length < minPoints) {
      labels[index] = -1;
      continue;
    }

    labels[index] = cluster;
    const queue = [...nearby];
    const queued = new Set(queue);
    while (queue.length) {
      const current = queue.shift();
      if (!visited.has(current)) {
        visited.add(current);
        const expanded = neighbours(current);
        if (expanded.length >= minPoints) {
          for (const candidate of expanded) {
            if (!queued.has(candidate)) {
              queue.push(candidate);
              queued.add(candidate);
            }
          }
        }
      }
      if (labels[current] == null || labels[current] === -1) labels[current] = cluster;
    }
    cluster += 1;
  }

  return labels.map(label => label ?? -1);
}

function sameNonNull(values) {
  const filtered = values.filter(value => value != null && value !== "none");
  if (!filtered.length || filtered.length !== values.length) return null;
  return filtered.every(value => value === filtered[0]) ? filtered[0] : null;
}

function medianMetric(incidents, key) {
  return median(incidents.map(item => finite(item.metrics?.[key])).filter(Number.isFinite));
}

export function explainIncidentGroup(incidents) {
  if (!incidents.length) return [];
  const explanations = [];
  const domains = incidents.map(item => item.diagnosis?.faultDomain || null);
  const sameDomain = sameNonNull(domains);
  if (sameDomain) explanations.push({ key: "faultDomain", label: `same fault domain: ${sameDomain.replaceAll("_", " ")}` });

  if (incidents.every(item => Number(item.metrics?.gatewayLoss ?? 0) < 2)) {
    explanations.push({ key: "gatewayLoss", label: "healthy local-gateway loss across cases" });
  }
  if (medianMetric(incidents, "upstreamLoss") >= 5) {
    explanations.push({ key: "upstreamLoss", label: "elevated upstream packet loss" });
  }
  if (medianMetric(incidents, "jitterMs") >= 30) {
    explanations.push({ key: "jitterMs", label: "elevated latency variation" });
  }
  if (incidents.every(item => item.metrics?.dnsResolved === true)) {
    explanations.push({ key: "dnsResolved", label: "DNS succeeds across cases" });
  }
  if (incidents.every(item => item.metrics?.externalProbeHealthy === true)) {
    explanations.push({ key: "externalProbeHealthy", label: "independent remote vantage remains healthy" });
  }
  if (incidents.every(item => item.metrics?.vpnRequired === false || item.metrics?.vpnRequired == null)) {
    explanations.push({ key: "vpnRequired", label: "VPN is not a shared dependency" });
  }

  const contractIds = incidents.map(item => item.telemetry?.connectivityContract?.contract?.id || item.connectivityContract?.id || null);
  const contractId = sameNonNull(contractIds);
  if (contractId) explanations.push({ key: "contractId", label: `same Connectivity Contract: ${contractId}` });

  const failureTypes = incidents.map(item => item.metrics?.contractFailureType || item.telemetry?.connectivityContract?.firstFailureType || null);
  const failureType = sameNonNull(failureTypes);
  if (failureType) explanations.push({ key: "contractFailureType", label: `same contract failure stage: ${failureType.toUpperCase()}` });

  return explanations.slice(0, 5);
}

function explainPair(left, right) {
  const reasons = [];
  if (left.diagnosis?.faultDomain && left.diagnosis.faultDomain === right.diagnosis?.faultDomain) {
    reasons.push(`same ${left.diagnosis.faultDomain.replaceAll("_", " ")} fault domain`);
  }
  if (Number(left.metrics?.gatewayLoss ?? 0) < 2 && Number(right.metrics?.gatewayLoss ?? 0) < 2) reasons.push("both local gateways are stable");
  const upstreamDelta = Math.abs(Number(left.metrics?.upstreamLoss ?? 0) - Number(right.metrics?.upstreamLoss ?? 0));
  if (upstreamDelta <= 2) reasons.push("similar upstream-loss level");
  const jitterDelta = Math.abs(Number(left.metrics?.jitterMs ?? 0) - Number(right.metrics?.jitterMs ?? 0));
  if (jitterDelta <= 15) reasons.push("similar jitter");
  if (left.metrics?.dnsResolved === right.metrics?.dnsResolved) reasons.push("same DNS outcome");
  if (typeof left.metrics?.externalProbeHealthy === "boolean" && left.metrics.externalProbeHealthy === right.metrics?.externalProbeHealthy) reasons.push("same remote-vantage outcome");
  if (left.metrics?.contractFailureType && left.metrics.contractFailureType === right.metrics?.contractFailureType) reasons.push(`same ${left.metrics.contractFailureType.toUpperCase()} contract failure stage`);
  return reasons.slice(0, 4);
}

export function analyseIncidents(incidents, options = {}) {
  const rows = incidents.filter(item => item?.id && item?.metrics);
  const featureSpace = fitIncidentFeatureSpace(rows);
  const vectors = rows.map(item => vectoriseIncident(item, featureSpace));
  const epsilon = Number(options.epsilon ?? 0.34);
  const minPoints = Number(options.minPoints ?? 3);
  const labels = dbscan(vectors, { epsilon, minPoints });

  const clusterMap = new Map();
  labels.forEach((label, index) => {
    if (label < 0) return;
    if (!clusterMap.has(label)) clusterMap.set(label, []);
    clusterMap.get(label).push(rows[index]);
  });

  const clusters = [...clusterMap.entries()].map(([label, members], index) => ({
    id: `PATTERN-${String(index + 1).padStart(2, "0")}`,
    label,
    size: members.length,
    incidentIds: members.map(item => item.id),
    commonCharacteristics: explainIncidentGroup(members)
  }));

  const patternByLabel = new Map(clusters.map(cluster => [cluster.label, cluster]));
  const byIncident = {};
  rows.forEach((incident, index) => {
    const neighbours = rows
      .map((candidate, candidateIndex) => {
        if (candidateIndex === index) return null;
        const distance = incidentDistance(vectors[index], vectors[candidateIndex]);
        return {
          id: candidate.id,
          title: candidate.title,
          distance: Number(distance.toFixed(4)),
          similarity: similarityFromDistance(distance),
          reasons: explainPair(incident, candidate)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);

    const pattern = labels[index] >= 0 ? patternByLabel.get(labels[index]) : null;
    byIncident[incident.id] = {
      clusterId: pattern?.id || null,
      noise: labels[index] < 0,
      neighbours
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    method: {
      name: "DBSCAN",
      epsilon,
      minPoints,
      distance: "weighted Euclidean over standardised numerical, binary and one-hot categorical features",
      supervised: false
    },
    featureSpace: {
      incidentCount: rows.length,
      numerical: NUMERIC_FEATURES.map(feature => feature.key),
      binary: BINARY_FEATURES.map(feature => feature.key),
      categorical: CATEGORICAL_FEATURES.map(feature => feature.key)
    },
    clusterCount: clusters.length,
    noiseCount: labels.filter(label => label < 0).length,
    clusters,
    incidents: byIncident
  };
}
