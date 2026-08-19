// Trigger detection.
//
// Pure functions over two consecutive samples. No timers, no I/O, no state
// beyond what is passed in, so every rule is directly testable and the recorder
// engine stays a scheduler rather than a decision-maker.
//
// The five triggers are deliberately few. A recorder that fires on everything
// captures nothing useful, and each additional rule is another way to produce
// an incident nobody asked about.
//
// One distinction runs through all of it: a trigger is an OBSERVATION that
// something changed, never a claim about cause. `NETWORK_STATE_CHANGE` in
// particular is not a fault - it is a marker that becomes relevant when a
// failure happens near it.

import { RESULT } from "../bisect/results.mjs";
import { NOT_SAMPLED } from "./sample.mjs";

export const TRIGGER = Object.freeze({
  TARGET_REACHABILITY: "TARGET_REACHABILITY_TRANSITION",
  CONTRACT_FAILURE: "CONNECTIVITY_CONTRACT_FAILURE",
  GATEWAY_DEGRADATION: "GATEWAY_DEGRADATION",
  NETWORK_STATE_CHANGE: "NETWORK_STATE_CHANGE",
  MANUAL: "MANUAL_CAPTURE"
});

/** Severity ranks how much a trigger justifies interrupting for a deep capture. */
export const TRIGGER_SEVERITY = Object.freeze({
  [TRIGGER.TARGET_REACHABILITY]: 100,
  [TRIGGER.CONTRACT_FAILURE]: 90,
  [TRIGGER.GATEWAY_DEGRADATION]: 60,
  [TRIGGER.MANUAL]: 50,
  // Lowest: a marker, not a fault.
  [TRIGGER.NETWORK_STATE_CHANGE]: 20
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  gatewayLossPct: 5,
  gatewayLatencyMs: 40
});

/**
 * Fields whose change is worth marking, and the Network Bisect axis (if any)
 * that can independently test whether that difference alters the outcome.
 *
 * A null axis is not an omission: a public IP change is a real observation that
 * Bisect has no experiment for, and saying so is more useful than implying it
 * could be tested.
 */
export const WATCHED_FIELDS = Object.freeze([
  {
    key: "activeInterface",
    label: "Active interface",
    read: sample => sample.local?.activeInterface ?? null,
    bisectAxis: "source-interface"
  },
  {
    key: "defaultRoute",
    label: "Default route",
    read: sample => {
      const route = sample.local?.route;
      return route ? `${route.destination} via ${route.nextHop} on ${route.interfaceAlias} metric ${route.metric}` : null;
    },
    // Route selection is not a Bisect axis, but the interface it selects is the
    // testable proxy for it.
    bisectAxis: "source-interface"
  },
  {
    key: "gateway",
    label: "Default gateway",
    read: sample => sample.local?.gateway ?? null,
    bisectAxis: null
  },
  {
    key: "resolvers",
    label: "DNS servers",
    read: sample => (sample.local?.resolvers || []).join(", ") || null,
    bisectAxis: "resolver"
  },
  {
    key: "wifiBssid",
    label: "Wi-Fi BSSID",
    read: sample => sample.local?.wifi?.bssid ?? null,
    bisectAxis: null
  },
  {
    key: "wifiSsid",
    label: "Wi-Fi SSID",
    read: sample => sample.local?.wifi?.ssid ?? null,
    bisectAxis: null
  },
  {
    key: "vpn",
    label: "VPN state",
    read: sample => {
      const vpn = sample.local?.vpn;
      if (!vpn) return null;
      return vpn.active ? `connected (${(vpn.adapters || []).join(", ") || "unnamed"})` : "not connected";
    },
    bisectAxis: "source-interface"
  },
  {
    key: "publicIp",
    label: "Public IP",
    read: sample => sample.path?.publicIp?.value ?? null,
    bisectAxis: null
  },
  {
    key: "resolvedAddress",
    label: "Resolved target address",
    read: sample => sample.path?.resolvedAddress ?? null,
    bisectAxis: "address",
    /**
     * CDN-hosted targets return a rotating subset of a stable address pool, so
     * a first-address comparison reports a change on almost every tick. Two
     * answer sets that overlap are the same pool; only fully disjoint sets are
     * treated as the target being repointed.
     */
    equals: (before, after) => {
      const a = before.path?.resolvedAddresses || [];
      const b = after.path?.resolvedAddresses || [];
      if (!a.length || !b.length) return true;
      return a.some(address => b.includes(address));
    }
  },
  {
    key: "ipv6",
    label: "IPv6 capability to target",
    read: sample => sample.connectivity?.ipv6?.state ?? null,
    bisectAxis: "address-family"
  },
  {
    key: "ipv4",
    label: "IPv4 capability to target",
    read: sample => sample.connectivity?.ipv4?.state ?? null,
    bisectAxis: "address-family"
  }
]);

/**
 * Compare two samples field by field.
 *
 * A field whose value is unknown on either side is not a difference: carrying a
 * slow-tier value forward, or failing to read it once, must not manufacture a
 * "route changed" that never happened.
 */
export function diffSamples(before, after, fields = WATCHED_FIELDS) {
  const changes = [];
  const unchanged = [];

  for (const field of fields) {
    const from = field.read(before);
    const to = field.read(after);
    if (from === null || to === null) continue;
    // A field may define its own equivalence where raw inequality is noise.
    const same = field.equals ? field.equals(before, after) : from === to;
    if (same) {
      unchanged.push({ key: field.key, label: field.label, value: to });
      continue;
    }
    changes.push({
      key: field.key,
      label: field.label,
      from,
      to,
      bisectAxis: field.bisectAxis,
      testable: Boolean(field.bisectAxis)
    });
  }

  return { changes, unchanged };
}

/**
 * Evaluate all automatic triggers for one sample transition.
 * Returns every trigger that fired; the caller decides what to do about them.
 */
export function detectTriggers(previous, current, { thresholds = DEFAULT_THRESHOLDS } = {}) {
  if (!previous || !current) return [];
  const fired = [];

  // 1. Target reachability transition. The most important signal: the thing the
  //    user cares about stopped working, or started working again.
  const was = previous.connectivity?.targetTcp?.state;
  const is = current.connectivity?.targetTcp?.state;
  if (was === RESULT.PASS && is === RESULT.FAIL) {
    fired.push({
      type: TRIGGER.TARGET_REACHABILITY,
      at: current.at,
      direction: "pass_to_fail",
      summary: "Target TCP reachability changed PASS → FAIL",
      detail: current.connectivity?.targetTcp?.error || null
    });
  } else if (was === RESULT.FAIL && is === RESULT.PASS) {
    fired.push({
      type: TRIGGER.TARGET_REACHABILITY,
      at: current.at,
      direction: "fail_to_pass",
      summary: "Target TCP reachability changed FAIL → PASS",
      // Recovery closes an incident; it does not open one.
      recovery: true
    });
  }

  // 2. Connectivity Contract failure. A required service condition stopped
  //    being met - stronger than raw reachability because it is the condition
  //    the service actually needs.
  const contractWas = previous.connectivity?.contract?.state;
  const contractIs = current.connectivity?.contract?.state;
  if (contractIs === "FAIL" && contractWas && contractWas !== "FAIL") {
    fired.push({
      type: TRIGGER.CONTRACT_FAILURE,
      at: current.at,
      summary: `Connectivity Contract ${current.connectivity.contract.contractId} failed`,
      detail: `Required check(s) failing: ${(current.connectivity.contract.failedRequired || []).join(", ") || "unknown"}`
    });
  }

  // 3. Gateway degradation. Crossing the threshold, not merely being above it,
  //    so a persistently lossy link does not retrigger on every tick.
  const gatewayNow = current.connectivity?.gateway;
  const gatewayBefore = previous.connectivity?.gateway;
  if (gatewayNow && gatewayNow.state !== NOT_SAMPLED && gatewayBefore && gatewayBefore.state !== NOT_SAMPLED) {
    const crossed = (field, limit) =>
      Number(gatewayBefore[field] ?? 0) < limit && Number(gatewayNow[field] ?? 0) >= limit;
    if (crossed("lossPct", thresholds.gatewayLossPct)) {
      fired.push({
        type: TRIGGER.GATEWAY_DEGRADATION,
        at: current.at,
        summary: `Gateway loss reached ${gatewayNow.lossPct}%`,
        detail: `Threshold ${thresholds.gatewayLossPct}%`
      });
    } else if (crossed("averageMs", thresholds.gatewayLatencyMs)) {
      fired.push({
        type: TRIGGER.GATEWAY_DEGRADATION,
        at: current.at,
        summary: `Gateway latency reached ${gatewayNow.averageMs} ms`,
        detail: `Threshold ${thresholds.gatewayLatencyMs} ms`
      });
    }
  }

  // 4. Network-state change. Not a fault. Recorded because it is exactly the
  //    context that makes a nearby failure interpretable.
  if (previous.path?.fingerprint && current.path?.fingerprint && previous.path.fingerprint !== current.path.fingerprint) {
    const { changes } = diffSamples(previous, current);
    if (changes.length) {
      fired.push({
        type: TRIGGER.NETWORK_STATE_CHANGE,
        at: current.at,
        summary: changes.length === 1
          ? `${changes[0].label} changed`
          : `${changes.length} network properties changed`,
        changes,
        // Stated on the trigger itself so no downstream consumer has to infer it.
        note: "A network-state change is an observation, not a fault."
      });
    }
  }

  return fired;
}

/** The trigger that should drive an incident, when several fire at once. */
export function primaryTrigger(triggers = []) {
  const actionable = triggers.filter(trigger => !trigger.recovery);
  if (!actionable.length) return null;
  return actionable.slice().sort((a, b) => (TRIGGER_SEVERITY[b.type] ?? 0) - (TRIGGER_SEVERITY[a.type] ?? 0))[0];
}

/** Does this trigger justify opening an incident and running a deep capture? */
export function opensIncident(trigger, { captureOnStateChange = false } = {}) {
  if (!trigger || trigger.recovery) return false;
  if (trigger.type === TRIGGER.NETWORK_STATE_CHANGE) return captureOnStateChange === true;
  return true;
}
