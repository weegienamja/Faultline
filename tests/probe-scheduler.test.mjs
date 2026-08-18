import test from "node:test";
import assert from "node:assert/strict";
import { selectProbe } from "../src/probe/scheduler.mjs";

const NOW = Date.parse("2026-08-18T21:00:00.000Z");

function probe(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    draining: false,
    maintenance: false,
    scope: "public",
    country: "gb",
    region: "europe-west",
    tags: ["uk", "vps"],
    lastSeenAt: new Date(NOW - 10_000).toISOString(),
    ...overrides
  };
}

test("chooses the least-loaded matching online probe", () => {
  const probes = [probe("PRB-A"), probe("PRB-B")];
  const sessions = [
    { id: "FL-1", assignedProbeId: "PRB-A", expiresAt: new Date(NOW + 60_000).toISOString() },
    { id: "FL-2", assignedProbeId: "PRB-A", expiresAt: new Date(NOW + 60_000).toISOString() }
  ];
  const selected = selectProbe({ probes, sessions, runs: [], selector: { scope: "public" }, now: NOW });
  assert.equal(selected.probe.id, "PRB-B");
  assert.equal(selected.load, 0);
  assert.equal(selected.candidateCount, 2);
});

test("matches country region and required tags", () => {
  const probes = [
    probe("PRB-GB"),
    probe("PRB-DE", { country: "de", region: "europe-central", tags: ["de", "vps"] })
  ];
  const selected = selectProbe({
    probes,
    selector: { country: "de", region: "europe-central", tags: ["vps"] },
    now: NOW
  });
  assert.equal(selected.probe.id, "PRB-DE");
});

test("excludes draining maintenance stale and disabled probes", () => {
  const probes = [
    probe("PRB-DRAIN", { draining: true }),
    probe("PRB-MAINT", { maintenance: true }),
    probe("PRB-STALE", { lastSeenAt: new Date(NOW - 2 * 60_000).toISOString() }),
    probe("PRB-DISABLED", { enabled: false }),
    probe("PRB-GOOD")
  ];
  assert.equal(selectProbe({ probes, now: NOW }).probe.id, "PRB-GOOD");
});

test("throws when no probe matches", () => {
  assert.throws(
    () => selectProbe({ probes: [probe("PRB-A")], selector: { country: "us" }, now: NOW }),
    /No online registered probe/
  );
});
