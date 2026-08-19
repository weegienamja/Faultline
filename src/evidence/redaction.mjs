// Schema-aware redaction for incident capsules.
//
// The case packager redacts by KEY NAME, recursively: any key called `ipv4`,
// `ipv6`, `gateway`, `hostname` and so on becomes "[redacted]". That works for
// case evidence, where those keys hold addresses.
//
// It is actively wrong for Recorder data, where the same names hold RESULTS:
//
//   "ipv6": { "state": "FAIL" }        <- a capability measurement
//   "gateway": { "state": "PASS", "lossPct": 0 }
//
// Blind key-name recursion would erase the diagnostic evidence and leave the
// identifiers-shaped fields that happen to be named differently. So capsule
// redaction names the exact paths that carry identifiers, and leaves everything
// else alone.
//
// The governing rule: redaction removes WHO AND WHERE, never WHAT HAPPENED.
// After redacting, a reader must still be able to see that IPv6 capability went
// PASS → FAIL, that the route changed, and that the resolver changed - just not
// the addresses involved.

export const REDACTION_MODES = Object.freeze(["none", "network-identifiers", "strict"]);

const REDACTED = "[redacted]";

/**
 * Identifier-bearing locations, addressed by path within a capsule.
 *
 * `*` matches any array index or object key at that position. A path is listed
 * only if the value at it identifies a person, machine or place - not if it
 * describes what the network did.
 */
const IDENTIFIER_PATHS = Object.freeze([
  // --- recorder samples ---------------------------------------------------
  "**.local.gateway",
  "**.local.activeInterface",
  "**.local.resolvers",
  "**.local.wifi.ssid",
  "**.local.wifi.bssid",
  "**.local.vpn.adapters",
  "**.local.interfaces.*.address",
  "**.local.interfaces.*.mac",
  "**.local.interfaces.*.name",
  "**.local.route.nextHop",
  "**.local.route.interfaceAlias",
  "**.local.route.destination",
  "**.path.publicIp.value",
  "**.path.resolvedAddress",
  "**.path.resolvedAddresses",
  // Only the ADDRESS a family probe used, never its state.
  "**.connectivity.ipv4.address",
  "**.connectivity.ipv6.address",
  // --- observed differences -----------------------------------------------
  // Handled by VALUE rather than by path, because the same field holds both
  // kinds of thing: "Ethernet -> Corp VPN" is an identifier pair, while
  // "PASS -> FAIL" is a capability result that must survive. See STATE_VALUES.
  "**.unchanged.*.value",
  // --- deep capture and bisect --------------------------------------------
  "**.deepCapture.resolvedAddress",
  "**.deepCapture.path.*.address",
  "**.interfaces.*.address",
  "**.interfaces.*.name",
  "**.baseline.reason",
  // --- narrative and experiment labels ------------------------------------
  // Free prose quotes addresses and interface names verbatim, and so do
  // experiment identifiers: a source-interface experiment is literally named
  // after the address it binds to. The axis, result and trial counts survive,
  // which is what actually carries the evidence.
  // Both shapes: the incident nests prose under `observedChange`, while the
  // capsule restructures it under `comparison`. Redaction runs on the capsule,
  // so the capsule-shaped paths are the ones that actually matter - the
  // incident-shaped ones cover any raw copy nested inside.
  "**.observedChange.statement",
  "**.comparison.statement",

  "**.verdict.detail",
  "**.conclusion.detail",
  "**.transcript.*.action",
  "**.transcript.*.detail",
  "**.experiments.executed.*.label",
  "**.experiments.executed.*.id",
  "**.experiments.skipped.*.label",
  "**.experiments.skipped.*.id",
  "**.confirmation.label",
  "**.confirmation.experimentId",
  "**.experiment.label",
  "**.experiment.id"
]);

/** Additionally removed in strict mode: the subject of the investigation. */
const STRICT_PATHS = Object.freeze([
  "**.target.host",
  "**.target.input",
  "**.target.url",
  "**.incident.target.host",
  // Hypothesis labels and headlines are generic engine vocabulary rather than
  // identifiers, so they only go in strict mode.
  "**.hypotheses.*.label",
  "**.verdict.headline",
  "**.conclusion.headline"
]);

/**
 * Transition values that are engine vocabulary, not identifiers.
 *
 * A difference reads "<property> from X to Y". Whether X and Y are sensitive
 * depends entirely on what they are: an interface name identifies a machine, a
 * PASS does not. Redacting both would destroy the evidence redaction exists to
 * preserve - "IPv6 capability went PASS to FAIL" is the whole point.
 */
const STATE_VALUES = new Set([
  "PASS", "FAIL", "INAPPLICABLE", "UNSUPPORTED", "UNSTABLE", "UNKNOWN", "NOT-SAMPLED", "NOT-MEASURED",
  "CONNECTED", "NOT CONNECTED", "TRUE", "FALSE", "NULL", "ACTIVE", "INACTIVE"
]);

function isStateValue(value) {
  if (typeof value === "boolean" || value === null) return true;
  if (typeof value !== "string") return false;
  return STATE_VALUES.has(value.trim().toUpperCase());
}

/** Fields holding a transition value, keyed by the object shape they live in. */
const TRANSITION_FIELDS = Object.freeze(["from", "to", "healthyValue", "failingValue"]);

/**
 * Redact a transition value only when it is an identifier.
 * Returns the value unchanged when it is engine vocabulary.
 */
function redactTransition(value, counter) {
  if (isStateValue(value)) return value;
  counter.count += 1;
  return REDACTED;
}

/** Compile `a.b.*.c` / `**.x` into a matcher over a concrete path array. */
function compile(pattern) {
  const parts = pattern.split(".");
  return path => {
    // `**` prefix: match the remaining segments as a suffix of the path.
    if (parts[0] === "**") {
      const tail = parts.slice(1);
      if (tail.length > path.length) return false;
      const offset = path.length - tail.length;
      return tail.every((part, index) => part === "*" || part === String(path[offset + index]));
    }
    if (parts.length !== path.length) return false;
    return parts.every((part, index) => part === "*" || part === String(path[index]));
  };
}

function matchersFor(mode) {
  const patterns = mode === "strict" ? [...IDENTIFIER_PATHS, ...STRICT_PATHS] : IDENTIFIER_PATHS;
  return patterns.map(compile);
}

function redactAt(value, path, matchers, counter) {
  if (matchers.some(match => match(path))) {
    counter.count += 1;
    // Arrays of identifiers collapse to a single marker rather than a list of
    // markers, which would leak how many there were.
    return Array.isArray(value) ? [REDACTED] : REDACTED;
  }
  if (Array.isArray(value)) return value.map((item, index) => redactAt(item, [...path, index], matchers, counter));
  if (value && typeof value === "object") {
    // A difference / candidate entry: its transition values are decided by what
    // they contain, not by where they sit.
    const isTransition = TRANSITION_FIELDS.some(field => Object.hasOwn(value, field));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isTransition && TRANSITION_FIELDS.includes(key)
        ? redactTransition(item, counter)
        : redactAt(item, [...path, key], matchers, counter)
    ]));
  }
  return value;
}

export function assertRedactionMode(mode) {
  const value = String(mode ?? "none");
  if (!REDACTION_MODES.includes(value)) {
    const error = new Error(`Unsupported redaction mode "${value.slice(0, 40)}". Use one of: ${REDACTION_MODES.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

/**
 * Apply redaction to a capsule payload.
 *
 * Returns the payload plus a description of what was done, so the capsule can
 * state its own redaction state rather than leaving a reader to guess whether
 * "[redacted]" means "hidden" or "not measured".
 */
export function redactCapsule(payload, mode = "none") {
  const applied = assertRedactionMode(mode);
  if (applied === "none") {
    return {
      payload: structuredClone(payload),
      redaction: {
        mode: "none",
        applied: false,
        note: "No redaction. Network identifiers are present as measured."
      }
    };
  }

  const counter = { count: 0 };
  const redacted = redactAt(structuredClone(payload), [], matchersFor(applied), counter);

  return {
    payload: redacted,
    redaction: {
      mode: applied,
      applied: true,
      fieldsRedacted: counter.count,
      note: applied === "strict"
        ? "Network identifiers and the target's identity are replaced with [redacted]. Measured states, results and transitions are preserved."
        : "Network identifiers (addresses, interface names, SSIDs, BSSIDs, resolvers, public IP) are replaced with [redacted]. Measured states, results and transitions are preserved.",
      // The property that makes a redacted capsule still worth reading.
      preserved: "What happened is intact: capability results, state transitions, which property changed, experiment outcomes and every deterministic conclusion."
    }
  };
}

export { IDENTIFIER_PATHS, STRICT_PATHS, REDACTED };
