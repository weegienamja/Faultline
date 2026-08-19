// Shared topology view-model helpers.
//
// Two collectors produce topology evidence and their shapes differ:
//   src/topology/infer.mjs      nodes carry `role`; links are {id, source, target, type}
//   src/client/windows-client   nodes carry only `type`; links are {from, to, relation}
//
// The packaged Windows client is deliberately self-contained for the single-file
// SEA build, so it cannot import src/topology/infer.mjs. These helpers keep the
// dashboard renderer tolerant of both shapes instead of silently dropping links.

export function topologyRole(node) {
  if (node.role) return node.role;
  const type = String(node.type || "").toLowerCase();
  if (["endpoint", "laptop"].includes(type)) return "endpoint";
  if (["gateway", "router"].includes(type)) return "gateway";
  if (["access-point", "access_point", "mesh", "mesh-node"].includes(type)) return "access";
  if (["boundary", "internet"].includes(type)) return "boundary";
  return "neighbour";
}

export function normaliseTopology(topology) {
  return {
    ...topology,
    nodes: (topology?.nodes || []).map(node => ({ ...node, role: topologyRole(node) })),
    links: (topology?.links || []).map((link, index) => ({
      ...link,
      id: link.id || `link-${index + 1}`,
      source: link.source ?? link.from,
      target: link.target ?? link.to,
      type: link.type ?? link.relation ?? null
    }))
  };
}

// --------------------------------------------------------------------------
// Live path enrichment
// --------------------------------------------------------------------------
//
// Extends an inferred LOCAL topology with the genuinely observed public path
// and the routing ownership of each public hop. Node/link classes stay
// explicit so OBSERVED, INFERRED and PUBLIC ROUTING METADATA never blur:
//
//   evidence: "observed"          measured (traceroute hop responded)
//   evidence: "inferred"          derived from local adapter/neighbour state
//   evidence: "routing-metadata"  ASN/owner label attached to a hop address
//
// Physical topology is never fabricated from BGP or PeeringDB data.

export function buildLivePathTopology(liveResult) {
  const base = normaliseTopology(liveResult?.inferred?.topology || { nodes: [], links: [] });
  const hops = (liveResult?.observed?.path || []).filter(hop => hop.scope === "public" && hop.ip);
  const nodes = [...base.nodes];
  const links = [...base.links];

  // Everything local keeps its inferred/observed classification.
  for (const node of nodes) if (!node.evidence) node.evidence = node.observed ? "observed" : "inferred";
  for (const link of links) if (!link.evidence) link.evidence = link.observed ? "observed" : "inferred";

  const boundary = nodes.find(node => node.role === "boundary");
  let previousId = boundary?.id || nodes.find(node => node.role === "gateway")?.id || null;

  // Collapse consecutive hops in the same ASN into one network node: a
  // traceroute proves transit through the network, not per-router topology.
  const segments = [];
  for (const hop of hops) {
    const key = hop.asn != null ? `as:${hop.asn}` : `ip:${hop.ip}`;
    const last = segments[segments.length - 1];
    if (last && last.key === key) { last.hops.push(hop); continue; }
    segments.push({ key, asn: hop.asn, network: hop.network, prefix: hop.prefix, hops: [hop] });
  }

  for (const [index, segment] of segments.entries()) {
    const id = `net:${segment.key}`;
    if (nodes.some(node => node.id === id)) continue;
    const rtts = segment.hops.map(hop => hop.averageRttMs).filter(v => typeof v === "number");
    nodes.push({
      id,
      type: "transit",
      role: "transit",
      label: segment.network || (segment.asn != null ? `AS${segment.asn}` : segment.hops[0].ip),
      asn: segment.asn,
      prefix: segment.prefix,
      ip: segment.hops[0].ip,
      hopCount: segment.hops.length,
      rttMs: rtts.length ? Math.min(...rtts) : null,
      confidence: "high",
      observed: true,
      // The hop responded (observed); the owner label is routing metadata.
      evidence: "observed",
      ownerEvidence: segment.asn != null ? "routing-metadata" : "unknown"
    });
    if (previousId) {
      links.push({
        id: `path-${index + 1}`,
        source: previousId,
        target: id,
        type: "observed-path",
        observed: true,
        evidence: "observed",
        confidence: "high",
        reason: "A traceroute hop in this network responded, so traffic demonstrably transited it."
      });
    }
    previousId = id;
  }

  // Finally the target service itself.
  const routing = liveResult?.internetContext?.routing || null;
  const targetId = "target-service";
  if (liveResult?.target?.resolvedAddress && !nodes.some(node => node.id === targetId)) {
    nodes.push({
      id: targetId,
      type: "service",
      role: "target",
      label: liveResult.target.host,
      ip: liveResult.target.resolvedAddress,
      asn: routing?.originAsn ?? null,
      prefix: routing?.prefix ?? null,
      network: routing?.asnName ?? null,
      confidence: "high",
      observed: Boolean(liveResult.observed?.tcp?.ok),
      evidence: liveResult.observed?.tcp?.ok ? "observed" : "inferred",
      ownerEvidence: routing?.originAsn != null ? "routing-metadata" : "unknown"
    });
    if (previousId) {
      links.push({
        id: "path-target",
        source: previousId,
        target: targetId,
        type: liveResult.observed?.tcp?.ok ? "observed-path" : "inferred-uplink",
        observed: Boolean(liveResult.observed?.tcp?.ok),
        evidence: liveResult.observed?.tcp?.ok ? "observed" : "inferred",
        confidence: liveResult.observed?.tcp?.ok ? "high" : "low",
        reason: liveResult.observed?.tcp?.ok
          ? "A TCP connection to the target completed from this endpoint."
          : "The target did not complete a transport connection from this endpoint."
      });
    }
  }

  const affectedPath = [
    ...(base.affectedPath || []),
    ...segments.map(segment => `net:${segment.key}`),
    ...(nodes.some(node => node.id === targetId) ? [targetId] : [])
  ].filter((value, index, all) => all.indexOf(value) === index);

  return {
    ...base,
    nodes,
    links,
    affectedPath,
    kind: segments.length ? "internet-path" : base.kind,
    summary: segments.length
      ? `Local topology inferred from this endpoint, extended with ${segments.length} public network segment(s) proven by traceroute and labelled with public routing metadata.`
      : base.summary
  };
}
