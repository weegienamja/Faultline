import test from "node:test";
import assert from "node:assert/strict";
import { buildTopology, normaliseMac } from "../src/topology/infer.mjs";

test("normalises common MAC address formats", () => {
  assert.equal(normaliseMac("AA-BB-CC-DD-EE-FF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normaliseMac("aa:bb:cc:dd:ee:ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normaliseMac("invalid"), null);
});

test("builds a high-confidence direct Wi-Fi star when BSSID matches gateway", () => {
  const topology = buildTopology({
    endpoint: { hostname: "WORK-LAPTOP", ip: "192.168.1.20", mac: "10-20-30-40-50-60", connection: "Wi-Fi" },
    gateway: { ip: "192.168.1.1" },
    wifi: { ssid: "Office", bssid: "AA-BB-CC-11-22-33", signalPct: 78 },
    neighbours: [
      { ip: "192.168.1.1", mac: "AA-BB-CC-11-22-33", state: "Reachable" },
      { ip: "192.168.1.44", mac: "12-34-56-78-90-AB", state: "Stale" }
    ]
  });

  assert.equal(topology.kind, "star");
  assert.equal(topology.nodes.some(node => node.id === "wireless-access"), false);
  assert.equal(topology.links.find(link => link.id === "endpoint-gateway")?.type, "wifi");
  assert.equal(topology.discovery.activeScan, false);
});

test("infers a separate access layer when BSSID differs from gateway", () => {
  const topology = buildTopology({
    endpoint: { hostname: "LAPTOP", ip: "192.168.10.50", connection: "Wi-Fi" },
    gateway: { ip: "192.168.10.1" },
    wifi: { ssid: "Home", bssid: "11:22:33:AA:BB:CC", signalPct: 61 },
    neighbours: [{ ip: "192.168.10.1", mac: "44:55:66:11:22:33", state: "Reachable" }]
  });

  assert.equal(topology.kind, "tree");
  assert.equal(topology.nodes.find(node => node.id === "wireless-access")?.type, "access-point");
  assert.equal(topology.links.find(link => link.id === "wireless-gateway")?.observed, false);
});

test("marks same-OUI separate wireless node as low-confidence mesh evidence", () => {
  const topology = buildTopology({
    endpoint: { hostname: "LAPTOP", ip: "192.168.50.20", connection: "Wi-Fi" },
    gateway: { ip: "192.168.50.1" },
    wifi: { ssid: "Mesh", bssid: "AA:BB:CC:10:20:30", signalPct: 54 },
    neighbours: [{ ip: "192.168.50.1", mac: "AA:BB:CC:99:88:77", state: "Reachable" }]
  });

  assert.equal(topology.kind, "mesh");
  assert.equal(topology.confidence, "low");
  assert.equal(topology.nodes.find(node => node.id === "wireless-access")?.type, "mesh-node");
  assert.match(topology.summary, /mesh|wireless hop/i);
});

test("does not claim direct physical Ethernet attachment", () => {
  const topology = buildTopology({
    endpoint: { hostname: "DESKTOP", ip: "10.0.0.20", connection: "Ethernet" },
    gateway: { ip: "10.0.0.1" },
    neighbours: [{ ip: "10.0.0.1", mac: "AA:00:00:00:00:01", state: "Reachable" }]
  });

  const path = topology.links.find(link => link.id === "endpoint-gateway");
  assert.equal(topology.kind, "star");
  assert.equal(path.type, "ethernet-path");
  assert.equal(path.observed, false);
  assert.equal(path.confidence, "medium");
});

test("returns an unknown topology without a gateway", () => {
  const topology = buildTopology({ endpoint: { hostname: "ISOLATED" } });
  assert.equal(topology.kind, "unknown");
  assert.equal(topology.confidence, "low");
  assert.equal(topology.nodes.length, 1);
});
