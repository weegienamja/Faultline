// Network condition space for bisection.
//
// THE CENTRAL IDEA. Support desks isolate connectivity faults by mutating the
// machine: "turn Wi-Fi off", "disable IPv6", "drop the VPN", "try your phone
// hotspot", "change your DNS". That is slow, disruptive, needs admin rights,
// and is often impossible on a managed endpoint.
//
// Almost every one of those conditions can instead be varied PER CONNECTION,
// leaving the operating system untouched:
//
//   address family   -> choose A vs AAAA for this connection only
//   resolver         -> query a specific nameserver for this lookup only
//   resolved address -> connect to one specific answer out of several
//   source interface -> bind localAddress to one NIC (VPN vs direct, no toggle)
//   TLS version      -> pin min/max for this handshake only
//   ALPN             -> offer h2 or http/1.1 only
//   SNI              -> send or omit the server name
//   port             -> 443 vs 80
//
// Nothing here changes system configuration, requires elevation, or disturbs
// other traffic. Each axis is a controlled variable in an experiment.

import os from "node:os";

/**
 * A condition axis. `baseline` is what an ordinary connection does; each
 * variant is a single deliberate deviation from it.
 */
function axis(id, label, baseline, variants, meta = {}) {
  return { id, label, baseline, variants, ...meta };
}

export const BASELINE = "baseline";

/**
 * Local IPv4 source addresses that can be bound with `localAddress`.
 * A machine on a VPN normally has both the tunnel address and the physical
 * address here, so binding each one tests "over the tunnel" against "direct"
 * without disconnecting anything.
 */
export function localSourceAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces() || {})) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      if (address.family !== "IPv4" && address.family !== 4) continue;
      // Link-local autoconfiguration addresses cannot originate useful traffic.
      if (address.address.startsWith("169.254.")) continue;
      found.push({ interface: name, address: address.address });
    }
  }
  return found;
}

/**
 * Build the axis list for one target. Axes that cannot apply to this target
 * (for example TLS axes against a plain-HTTP target) are omitted rather than
 * being reported as failures.
 */
export function buildConditionSpace(target, {
  resolvers = ["1.1.1.1", "8.8.8.8", "9.9.9.9"],
  includeSourceInterface = true,
  includePort = true,
  resolvedAddresses = { v4: [], v6: [] }
} = {}) {
  const axes = [];
  const https = target.scheme === "https";

  // --- Address family -----------------------------------------------------
  // The single most common silent failure: AAAA resolves, the v6 path is
  // broken, and the application stalls before falling back.
  if (!target.isLiteralIp) {
    axes.push(axis("address-family", "IP address family", "auto", [
      { value: "ipv4", label: "IPv4 only" },
      { value: "ipv6", label: "IPv6 only" }
    ], { rationale: "Isolates a broken IPv6 (or IPv4) path from the dual-stack default." }));
  }

  // --- Resolver -----------------------------------------------------------
  // Catches captive/ISP/corporate resolvers answering differently, stale
  // records, split-horizon DNS and DNS hijacking.
  if (!target.isLiteralIp) {
    axes.push(axis("resolver", "DNS resolver", "system", resolvers.map(address => ({
      value: address, label: `resolver ${address}`
    })), { rationale: "Isolates a resolver returning a different or unusable answer." }));
  }

  // --- Specific resolved address -----------------------------------------
  // Anycast and multi-origin services can have one unhealthy node. Connecting
  // to each answer individually finds it.
  const addressVariants = [
    ...resolvedAddresses.v4.map(a => ({ value: a, label: `address ${a}`, family: 4 })),
    ...resolvedAddresses.v6.map(a => ({ value: a, label: `address ${a}`, family: 6 }))
  ];
  if (addressVariants.length > 1) {
    axes.push(axis("address", "Specific resolved address", "auto", addressVariants.slice(0, 8), {
      rationale: "Isolates one unhealthy address among several answers."
    }));
  }

  // --- Source interface ---------------------------------------------------
  // VPN vs direct, Wi-Fi vs Ethernet, without touching the adapters.
  // A loopback target can only be reached from a loopback source, so varying
  // the egress interface is meaningless.
  const loopbackTarget = /^(127\.|::1$|localhost$)/i.test(target.host);
  if (includeSourceInterface && !loopbackTarget) {
    const sources = localSourceAddresses();
    if (sources.length > 1) {
      axes.push(axis("source-interface", "Local source interface", "auto",
        sources.map(s => ({ value: s.address, label: `via ${s.interface} (${s.address})`, interface: s.interface })),
        { rationale: "Compares egress interfaces (VPN tunnel vs physical) without disconnecting either." }));
    }
  }

  // --- TLS version --------------------------------------------------------
  // TLS-inspecting middleboxes commonly break exactly one version.
  if (https) {
    axes.push(axis("tls-version", "TLS version", "auto", [
      { value: "TLSv1.2", label: "TLS 1.2 only" },
      { value: "TLSv1.3", label: "TLS 1.3 only" }
    ], { rationale: "Isolates a middlebox or server that fails one TLS version." }));

    // --- ALPN -------------------------------------------------------------
    // Decided at the TLS stage. This client speaks HTTP/1.1, so if it forced
    // ALPN to h2 and then issued an HTTP/1.1 request the server's h2 preface
    // would fail to parse and be misreported as a network fault. The useful
    // question is whether the handshake can negotiate the protocol at all,
    // which is what a middlebox that mishandles h2 actually breaks.
    axes.push(axis("alpn", "ALPN protocol", "auto", [
      { value: "h2", label: "HTTP/2 only" },
      { value: "http/1.1", label: "HTTP/1.1 only" }
    ], { rationale: "Isolates a middlebox that cannot negotiate one HTTP version.", stopAt: "tls" }));

    // --- SNI --------------------------------------------------------------
    // Omitting SNI legitimately breaks any name-based virtual host, which is
    // most of the web. Flagged as an expected difference so it is reported
    // but never promoted above a real finding.
    axes.push(axis("sni", "TLS SNI", "on", [
      { value: "off", label: "no SNI" }
    ], { rationale: "Isolates SNI-based filtering. Note that name-based virtual hosts fail without SNI by design.",
         stopAt: "tls", expectedDifference: true }));
  }

  // --- Port ---------------------------------------------------------------
  if (includePort && https && target.port === 443) {
    axes.push(axis("port", "Destination port", 443, [
      { value: 80, label: "port 80" }
    ], { rationale: "Isolates port-specific filtering." }));
  }

  return axes;
}

/**
 * A trial is the baseline assignment with at most one axis overridden.
 * Keeping trials single-factor is what makes an observed difference
 * attributable to that factor.
 */
export function baselineAssignment(axes) {
  return Object.fromEntries(axes.map(a => [a.id, a.baseline]));
}

export function variantAssignment(axes, axisId, value) {
  return { ...baselineAssignment(axes), [axisId]: value };
}

/**
 * Two assignments that produce the same effective connection tuple are the
 * same experiment wearing different names (for example address-family=ipv4
 * and address=<the only v4 answer>). The engine uses this to collapse
 * duplicate findings.
 */
export function effectiveTuple(plan) {
  return [
    plan.family ?? "auto",
    plan.address ?? "resolved",
    plan.localAddress ?? "auto",
    plan.port,
    plan.tlsVersion ?? "auto",
    plan.alpn ?? "auto",
    plan.sni === false ? "no-sni" : "sni"
  ].join("|");
}
