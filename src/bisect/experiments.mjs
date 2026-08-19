// Experiment registry.
//
// An experiment is one controlled variation: exactly one axis moves, everything
// else is held at baseline. Axes register themselves with a uniform shape so a
// future axis (packet size / DF bit, proxy, gateway, MTU threshold) can be
// added without touching the planner:
//
//   applicability(context) -> { applicable, reason }   can this run at all?
//   variants(context)      -> [{ value, label, ... }]  what can it be set to?
//   cost                   -> connections per trial (relative expense)
//   intrusiveness          -> 0 none, 1 unusual-but-safe
//   stopAt                 -> stage that decides the verdict, if not the whole stack
//   interpret(observation) -> optional narrowing note for the transcript
//
// The planner only ever sees this interface, never the mechanics of how a
// condition is applied.

import net from "node:net";
import { IFACE, ROUTE } from "./interfaces.mjs";

export const COST = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 });

function ok(variants, extra = {}) {
  return { applicable: true, variants, ...extra };
}
function no(reason) {
  return { applicable: false, variants: [], reason };
}

/**
 * The axis catalogue. Order here is the deterministic tie-break order used by
 * the planner when scores are equal, so it is meaningful: broadly, cheaper and
 * more fundamental axes first.
 */
export const AXES = [
  {
    id: "address-family",
    label: "IP address family",
    rationale: "Separates a broken IPv6 (or IPv4) path from the dual-stack default.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      if (context.target.isLiteralIp) return no("The target is a literal IP address, so the family is already fixed.");
      const variants = [];
      if (context.answers.v4.length) variants.push({ value: "ipv4", label: "IPv4 only" });
      else variants.push({ value: "ipv4", label: "IPv4 only", expectMissing: true });
      if (context.answers.v6.length) variants.push({ value: "ipv6", label: "IPv6 only" });
      else variants.push({ value: "ipv6", label: "IPv6 only", expectMissing: true });
      return ok(variants);
    }
  },

  {
    id: "resolver",
    label: "DNS resolver",
    rationale: "Separates a resolver returning a different or unusable answer from a path problem.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      if (context.target.isLiteralIp) return no("The target is a literal IP address, so no resolver is involved.");
      return ok(context.resolvers.map(address => ({ value: address, label: `resolver ${address}` })));
    }
  },

  {
    id: "address",
    label: "Specific resolved address",
    rationale: "Separates one unhealthy address among several answers from a whole-family problem.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      const all = [
        ...context.answers.v4.map(a => ({ value: a, label: `address ${a}`, family: 4 })),
        ...context.answers.v6.map(a => ({ value: a, label: `address ${a}`, family: 6 }))
      ];
      if (all.length < 2) return no("The target resolves to a single address, so there is nothing to compare.");
      return ok(all.slice(0, 8));
    }
  },

  {
    id: "source-interface",
    label: "Local source interface",
    rationale: "Compares egress interfaces (tunnel vs physical) without disconnecting either.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      const usable = context.interfaces.filter(i => i.classification !== IFACE.LOOPBACK);
      if (usable.length < 2) return no("Only one non-loopback interface is present, so there is nothing to compare.");
      if (context.targetIsLoopback) return no("A loopback target can only be reached from a loopback source.");
      return ok(usable.map(i => ({
        value: i.address,
        label: `via ${i.name} (${i.address})`,
        interfaceName: i.name,
        classification: i.classification,
        // An interface the OS will not select for this destination cannot
        // carry the connection. Marked here so it is never run as if it could.
        inapplicable: i.routeSupport === ROUTE.NO_ROUTE,
        inapplicableReason: i.routeReason
      })));
    }
  },

  {
    id: "tls-version",
    label: "TLS version",
    rationale: "Separates a middlebox or server that fails one TLS version from a path problem.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      if (context.target.scheme !== "https") return no("The target is not HTTPS, so there is no TLS handshake to vary.");
      return ok([
        { value: "TLSv1.2", label: "TLS 1.2 only" },
        { value: "TLSv1.3", label: "TLS 1.3 only" }
      ]);
    }
  },

  {
    id: "alpn",
    label: "ALPN protocol",
    rationale: "Separates a middlebox that cannot negotiate one HTTP version from a transport problem.",
    cost: COST.LOW,
    intrusiveness: 0,
    // Judged at the handshake: this client speaks HTTP/1.1, so forcing h2 and
    // then sending an HTTP/1.1 request would misreport the server's h2 preface
    // as a network fault.
    stopAt: "tls",
    applicability(context) {
      if (context.target.scheme !== "https") return no("The target is not HTTPS, so there is no ALPN to negotiate.");
      return ok([
        { value: "h2", label: "HTTP/2 only" },
        { value: "http/1.1", label: "HTTP/1.1 only" }
      ]);
    }
  },

  {
    id: "sni",
    label: "TLS SNI",
    rationale: "Separates SNI-based filtering from a transport problem. Name-based virtual hosts fail without SNI by design.",
    cost: COST.LOW,
    intrusiveness: 1,
    stopAt: "tls",
    expectedDifference: true,
    applicability(context) {
      if (context.target.scheme !== "https") return no("The target is not HTTPS, so SNI does not apply.");
      if (net.isIP(context.target.host)) return no("The target is an IP address, so no server name is sent.");
      return ok([{ value: "off", label: "no SNI" }]);
    }
  },

  {
    id: "port",
    label: "Destination port",
    rationale: "Separates port-specific filtering from host-level unreachability.",
    cost: COST.LOW,
    intrusiveness: 0,
    applicability(context) {
      if (context.target.scheme !== "https" || context.target.port !== 443) {
        return no("An alternate port comparison is only offered for the default HTTPS port.");
      }
      return ok([{ value: 80, label: "port 80" }]);
    }
  }
];

/**
 * Expand the catalogue into concrete experiments for this run.
 * Each experiment is one axis set to one value.
 *
 * `axes` restricts the run to named axes. Flight Recorder uses it to test only
 * the conditions it actually observed changing, rather than re-deriving the
 * whole matrix. An unknown or unavailable name is reported in `unavailable`
 * like any other axis - a restriction that silently matched nothing would look
 * identical to a run that found nothing.
 */
export function buildExperiments(context, { axes = null } = {}) {
  const experiments = [];
  const unavailable = [];
  const requested = Array.isArray(axes) && axes.length ? new Set(axes.map(String)) : null;

  if (requested) {
    const known = new Set(AXES.map(axis => axis.id));
    for (const name of requested) {
      if (!known.has(name)) {
        unavailable.push({ axisId: name, axisLabel: name, reason: "No Network Bisect experiment varies this condition." });
      }
    }
  }

  for (const axis of AXES) {
    if (requested && !requested.has(axis.id)) continue;
    const applicability = axis.applicability(context);
    if (!applicability.applicable) {
      unavailable.push({ axisId: axis.id, axisLabel: axis.label, reason: applicability.reason });
      continue;
    }
    for (const variant of applicability.variants) {
      experiments.push({
        id: `${axis.id}=${variant.value}`,
        axisId: axis.id,
        axisLabel: axis.label,
        value: variant.value,
        label: variant.label,
        rationale: axis.rationale,
        cost: axis.cost,
        intrusiveness: axis.intrusiveness,
        stopAt: axis.stopAt || null,
        expectedDifference: Boolean(axis.expectedDifference),
        // Carried from applicability so the planner can mark it without running.
        inapplicable: Boolean(variant.inapplicable),
        inapplicableReason: variant.inapplicableReason || null,
        meta: variant
      });
    }
  }

  return { experiments, unavailable, availableAxisIds: [...new Set(experiments.map(e => e.axisId))] };
}
