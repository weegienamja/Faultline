import test from "node:test";
import assert from "node:assert/strict";
import { buildTopology } from "../src/topology/infer.mjs";
import { normaliseTopology, topologyRole } from "../public/topology-view.js";

// The dashboard renders topology evidence from two independent collectors.
// src/topology/infer.mjs (npm agent) and the packaged Windows client emit
// different link/node shapes; the renderer must draw both.

function renderable(topology) {
  const positions = new Map(topology.nodes.map(node => [node.id, { x: 0, y: 0 }]));
  return topology.links.filter(link => link.id && positions.has(link.source) && positions.has(link.target)).length;
}

test("preserves the inferred-topology shape unchanged", () => {
  const built = buildTopology({
    endpoint: { hostname: "desk-1", ip: "192.168.1.10", mac: "AA-BB-CC-00-00-10" },
    gateway: { ip: "192.168.1.1" },
    wifi: { bssid: "AA-BB-CC-00-00-01" },
    neighbours: [{ ip: "192.168.1.1", mac: "AA-BB-CC-00-00-01", state: "Reachable" }]
  });

  const view = normaliseTopology(built);
  assert.deepEqual(view.links.map(link => link.id), built.links.map(link => link.id));
  assert.deepEqual(view.nodes.map(node => node.role), built.nodes.map(node => node.role));
  assert.equal(renderable(view), built.links.length);
});

test("renders packaged Windows client topology that omits link ids and node roles", () => {
  // Shape emitted by src/client/windows-client.mjs buildTopology().
  const clientTopology = {
    version: 1,
    kind: "star",
    confidence: "high",
    nodes: [
      { id: "endpoint", type: "endpoint", label: "desk-1", ip: "192.168.1.10" },
      { id: "gateway:192.168.1.1", type: "gateway", label: "Default gateway", ip: "192.168.1.1" },
      { id: "lan:192.168.1.44", type: "unknown", label: "192.168.1.44", ip: "192.168.1.44" },
      { id: "internet", type: "boundary", label: "Internet" }
    ],
    links: [
      { from: "endpoint", to: "gateway:192.168.1.1", relation: "wifi", observed: true },
      { from: "gateway:192.168.1.1", to: "lan:192.168.1.44", relation: "local-neighbour", observed: false },
      { from: "gateway:192.168.1.1", to: "internet", relation: "upstream", observed: false }
    ],
    affectedPath: ["endpoint", "gateway:192.168.1.1", "internet"]
  };

  assert.equal(renderable({ ...clientTopology, links: clientTopology.links.map(link => ({ ...link })) }), 0);

  const view = normaliseTopology(clientTopology);
  assert.equal(renderable(view), 3);
  assert.deepEqual(view.nodes.map(node => node.role), ["endpoint", "gateway", "neighbour", "boundary"]);
  assert.equal(view.links[0].source, "endpoint");
  assert.equal(view.links[0].target, "gateway:192.168.1.1");
  assert.equal(view.links[0].type, "wifi");
  assert.equal(new Set(view.links.map(link => link.id)).size, 3);
});

test("derives roles from both collector type vocabularies", () => {
  assert.equal(topologyRole({ role: "neighbour", type: "router" }), "neighbour");
  assert.equal(topologyRole({ type: "laptop" }), "endpoint");
  assert.equal(topologyRole({ type: "endpoint" }), "endpoint");
  assert.equal(topologyRole({ type: "router" }), "gateway");
  assert.equal(topologyRole({ type: "access_point" }), "access");
  assert.equal(topologyRole({ type: "mesh-node" }), "access");
  assert.equal(topologyRole({ type: "internet" }), "boundary");
  assert.equal(topologyRole({ type: "unknown" }), "neighbour");
});

test("live path topology extends the local map with observed public hops", async () => {
  const { buildLivePathTopology } = await import("../public/topology-view.js");
  const live = {
    target: { host: "example.com", resolvedAddress: "104.20.23.154" },
    observed: {
      tcp: { ok: true },
      path: [
        { hop: 1, ip: "192.168.0.1", scope: "private", enrichment: "skipped-private", averageRttMs: 2 },
        { hop: 2, ip: "10.0.0.1", scope: "private", enrichment: "skipped-private", averageRttMs: 9 },
        { hop: 3, ip: "62.253.1.1", scope: "public", asn: 5089, network: "Virgin Media", prefix: "62.253.0.0/16", averageRttMs: 14 },
        { hop: 4, ip: "62.253.1.2", scope: "public", asn: 5089, network: "Virgin Media", prefix: "62.253.0.0/16", averageRttMs: 15 },
        { hop: 5, ip: "104.20.23.154", scope: "public", asn: 13335, network: "CLOUDFLARENET", prefix: "104.20.16.0/20", averageRttMs: 16 }
      ]
    },
    inferred: {
      topology: {
        kind: "star", confidence: "high",
        nodes: [
          { id: "endpoint", role: "endpoint", type: "laptop", label: "pc", ip: "192.168.0.10", observed: true },
          { id: "gateway", role: "gateway", type: "router", label: "Default gateway", ip: "192.168.0.1", observed: true },
          { id: "internet", role: "boundary", type: "internet", label: "Internet", observed: false }
        ],
        links: [
          { id: "endpoint-gateway", source: "endpoint", target: "gateway", observed: true },
          { id: "gateway-internet", source: "gateway", target: "internet", observed: false }
        ],
        affectedPath: ["endpoint", "gateway", "internet"]
      }
    },
    internetContext: { routing: { originAsn: 13335, asnName: "CLOUDFLARENET", prefix: "104.20.16.0/20" } }
  };

  const map = buildLivePathTopology(live);

  // Private hops must not appear as public network nodes.
  const transit = map.nodes.filter(n => n.role === "transit");
  assert.equal(transit.length, 2, "consecutive hops in one ASN collapse to one network node");
  assert.deepEqual(transit.map(n => n.asn), [5089, 13335]);
  assert.equal(transit[0].hopCount, 2);
  assert.equal(map.nodes.some(n => String(n.ip).startsWith("192.168.")&& n.role === "transit"), false);

  // Evidence classes stay explicit.
  assert.equal(transit[0].evidence, "observed", "a responding hop is observed evidence");
  assert.equal(transit[0].ownerEvidence, "routing-metadata", "the owner label is metadata, not observation");
  assert.equal(map.nodes.find(n => n.id === "gateway").evidence, "observed");
  assert.equal(map.nodes.find(n => n.id === "internet").evidence, "inferred");

  // Target service is appended and the path is continuous.
  const target = map.nodes.find(n => n.role === "target");
  assert.equal(target.label, "example.com");
  assert.equal(target.asn, 13335);
  assert.ok(map.affectedPath.includes(target.id));
  assert.ok(map.links.some(l => l.target === target.id && l.evidence === "observed"));
  assert.equal(map.kind, "internet-path");
});

test("live path topology degrades safely with no public hops", async () => {
  const { buildLivePathTopology } = await import("../public/topology-view.js");
  const map = buildLivePathTopology({
    target: { host: "x.example", resolvedAddress: null },
    observed: { tcp: { ok: false }, path: [] },
    inferred: { topology: { kind: "star", nodes: [{ id: "endpoint", role: "endpoint" }], links: [] } }
  });
  assert.equal(map.nodes.filter(n => n.role === "transit").length, 0);
  assert.equal(map.nodes.some(n => n.role === "target"), false);
  assert.equal(map.kind, "star");
});
