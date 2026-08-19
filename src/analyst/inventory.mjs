// Evidence inventory.
//
// An 8B model answers honestly but does not always notice that relevant
// evidence exists. Asked "what does Faultline know about this target?", it
// would call get_current_target, get a target back, and stop - never learning
// that a completed Network Bisect run was sitting one tool call away.
//
// The fix is to tell it what CAN be retrieved before it chooses tools.
//
// The rule that keeps this safe: the inventory carries availability and the
// tool that fetches it, never the contents. Putting results here would
// reintroduce exactly what the tool gateway exists to prevent - evidence
// arriving in the prompt unvalidated, uncited and unbounded - and would let the
// model describe a run it never retrieved, with no reference table to check its
// citations against.
//
// So: "Latest Network Bisect: available (get_latest_bisect_run)".
// Never: "Latest Network Bisect: IPv6 failed 3/3".

import { EVIDENCE_KIND } from "./registry.mjs";

/**
 * Faultline concepts that exist in the product but have no read-only tool in
 * this version. Named explicitly so the model knows they are out of reach
 * rather than guessing that some tool might return them.
 */
const NOT_RETRIEVABLE = [
  "Change Assurance comparisons",
  "Connectivity Contract results",
  "Flight Recorder history (not implemented)"
];

/**
 * Build the inventory for the current request.
 *
 * Cheap by construction: two registry reads and at most two small store reads.
 * A store failure degrades that line to unknown rather than failing the ask -
 * an inventory is an aid to tool selection, not a precondition for answering.
 */
export async function buildEvidenceInventory({ registry, store, view }) {
  const bisect = registry?.latest(EVIDENCE_KIND.BISECT) ?? null;
  const live = registry?.latest(EVIDENCE_KIND.LIVE) ?? null;

  const target = view?.target || bisect?.target?.host || live?.target?.host || null;

  let caseCount = null;
  let probeCount = null;
  try {
    caseCount = (await store.listCases()).length;
  } catch {
    caseCount = null;
  }
  try {
    probeCount = (await store.listProbes()).length;
  } catch {
    probeCount = null;
  }

  // Topology is only meaningful once a path has actually been measured.
  const hasPath = Array.isArray(live?.observed?.path) && live.observed.path.length > 0;

  const entries = [
    {
      key: "target",
      label: "Current target",
      available: Boolean(target),
      // The one place a value appears, because the target IS the subject of the
      // question and naming it cannot be mistaken for a measurement.
      detail: target,
      tool: "get_current_target"
    },
    {
      key: "live",
      label: "Latest live diagnostic",
      available: Boolean(live),
      tool: "get_live_diagnostic"
    },
    {
      key: "diagnosis",
      label: "Deterministic fault-domain diagnosis",
      available: Boolean(live?.deterministic?.diagnosis),
      tool: "get_current_diagnosis"
    },
    {
      key: "bisect",
      label: "Latest Network Bisect run",
      available: Boolean(bisect),
      tool: "get_latest_bisect_run"
    },
    {
      key: "bisectPath",
      label: "Network Bisect experiment path and hypotheses",
      available: Boolean(bisect),
      tool: "get_bisect_experiment_path, get_bisect_hypotheses"
    },
    {
      key: "topology",
      label: "Measured path and inferred topology",
      available: hasPath,
      tool: "get_topology"
    },
    {
      key: "cases",
      label: "Support cases",
      available: caseCount !== null && caseCount > 0,
      detail: caseCount === null ? "unknown" : null,
      tool: "get_recent_cases, get_case"
    },
    {
      key: "probes",
      label: "Registered probe fleet",
      available: probeCount !== null && probeCount > 0,
      detail: probeCount === null ? "unknown" : null,
      tool: "get_probe_fleet"
    },
    {
      key: "docs",
      label: "Faultline documentation and engine vocabulary",
      // Shipped with the product, so always retrievable.
      available: true,
      tool: "search_faultline_docs, get_faultline_term"
    }
  ];

  return { target, entries, notRetrievable: [...NOT_RETRIEVABLE] };
}

/**
 * Render the inventory for the system prompt.
 *
 * Plain aligned text rather than JSON: it is read by a model as guidance, not
 * parsed, and a compact block costs fewer tokens than a nested object.
 */
export function renderEvidenceInventory(inventory) {
  if (!inventory?.entries?.length) return "";

  const lines = inventory.entries.map(entry => {
    const status = entry.available ? "available" : entry.detail === "unknown" ? "unknown" : "unavailable";
    const suffix = entry.available
      ? ` (${entry.tool})`
      : "";
    const detail = entry.key === "target" && entry.detail ? `: ${entry.detail}` : "";
    return `- ${entry.label}${detail} — ${status}${suffix}`;
  });

  return [
    "AVAILABLE FAULTLINE EVIDENCE",
    "This lists what you can retrieve right now, and the tool that retrieves it.",
    "It does NOT contain the evidence itself: you must call the tool to see any result.",
    "",
    ...lines,
    "",
    `Not retrievable by you in this version: ${inventory.notRetrievable.join("; ")}.`,
    "",
    "Call every tool marked available that bears on the question before answering.",
    "A question about what Faultline knows, or about the current target, should",
    "retrieve the diagnostic and isolation evidence listed above, not just the target."
  ].join("\n");
}
