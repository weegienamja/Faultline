import test from "node:test";
import assert from "node:assert/strict";
import {
  createRegisteredProbe,
  probeHealth,
  publicProbe,
  touchProbe,
  verifyProbeCredential
} from "../src/probe/registry.mjs";

test("creates a registered probe with a one-time credential", () => {
  const now = Date.parse("2026-08-18T19:00:00Z");
  const created = createRegisteredProbe({ name: "london-1", location: "London, UK", tags: ["UK", "VPS"] }, now);

  assert.match(created.probe.id, /^PRB-[A-F0-9]{10}$/);
  assert.match(created.credential, /^fl_probe_/);
  assert.equal(created.probe.tokenHash.includes(created.credential), false);
  assert.equal(verifyProbeCredential(created.probe, created.credential), true);
  assert.equal(verifyProbeCredential(created.probe, "wrong"), false);

  const safe = publicProbe(created.probe, now);
  assert.equal("tokenHash" in safe, false);
  assert.equal(safe.health, "offline");
  assert.deepEqual(safe.tags, ["uk", "vps"]);
});

test("moves probe health through online, stale and offline", () => {
  const base = Date.parse("2026-08-18T19:00:00Z");
  const { probe } = createRegisteredProbe({ name: "probe" }, base);
  const touched = touchProbe(probe, { runtime: { version: "0.5.0", platform: "linux", hostname: "probe-1" } }, base);

  assert.equal(probeHealth(touched, base + 60_000), "online");
  assert.equal(probeHealth(touched, base + 120_000), "stale");
  assert.equal(probeHealth(touched, base + 6 * 60_000), "offline");
  assert.equal(touched.runtime.hostname, "probe-1");
});

test("disabled probes cannot authenticate", () => {
  const { probe, credential } = createRegisteredProbe({ name: "probe" });
  assert.equal(verifyProbeCredential({ ...probe, enabled: false }, credential), false);
  assert.equal(probeHealth({ ...probe, enabled: false }), "disabled");
});
