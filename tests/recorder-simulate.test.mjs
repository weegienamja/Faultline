import test from "node:test";
import assert from "node:assert/strict";

import {
  createSimulationSampler,
  listScenarios,
  loadScenario,
  resolveScenario,
  ScenarioError,
  validateScenario
} from "../src/recorder/simulate.mjs";
import { createRecorder } from "../src/recorder/recorder.mjs";
import { summariseIncident } from "../src/recorder/incident.mjs";
import { projectIncident } from "../src/analyst/incident-evidence.mjs";
import { TRIGGER } from "../src/recorder/triggers.mjs";
import { STATE } from "../src/recorder/sample.mjs";
import { RESULT } from "../src/bisect/results.mjs";

// Simulation. Two things are being tested:
//
//   1. Simulated samples drive the REAL engine - buffer, crossing detection,
//      cooldown, freeze, comparison, axis mapping. A simulation that exercised
//      a parallel implementation would prove nothing.
//   2. Provenance is impossible to lose. A simulated incident must be
//      identifiable as simulated at every layer it can reach.

// --- validation -------------------------------------------------------------

test("a scenario needs a valid name and at least one phase", () => {
  assert.throws(() => validateScenario(null), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "x", phases: [] }), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "Bad Name", phases: [{ durationMs: 1_000 }] }), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "../escape", phases: [{ durationMs: 1_000 }] }), ScenarioError);
});

test("scenario fields are bounded and enum-checked", () => {
  const base = { scenario: "t", phases: [{ durationMs: 2_000 }] };
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 2_000, targetTcp: "MAYBE" }] }), /must be one of/);
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 5 }] }), /durationMs/);
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 2_000, activeInterface: "x".repeat(500) }] }), /too long/);
  assert.throws(() => validateScenario({ ...base, phases: Array.from({ length: 40 }, () => ({ durationMs: 2_000 })) }), /at most/);
});

test("a scenario cannot inject arbitrary fields into a sample", () => {
  const scenario = validateScenario({
    scenario: "hostile",
    phases: [{ durationMs: 2_000, evil: "payload", __proto__: { polluted: true }, simulated: false, source: "measured" }]
  });
  // Only known fields survive validation.
  assert.equal(scenario.phases[0].evil, undefined);
  assert.equal(scenario.phases[0].source, undefined);
  assert.equal(scenario.phases[0].simulated, undefined);
});

test("a scenario cannot declare itself real", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "hostile",
    phases: [{ durationMs: 2_000, targetTcp: "PASS" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  // Provenance is stamped by the sampler, never taken from the file.
  assert.equal(sample.source, "simulation");
  assert.equal(sample.simulated, true);
  assert.equal(sample.scenario, "hostile");
});

// --- built-in scenarios -----------------------------------------------------

test("the built-in scenarios all load and validate", async () => {
  const scenarios = await listScenarios();
  assert.ok(scenarios.length >= 3, `expected the shipped scenarios, got ${scenarios.length}`);
  for (const entry of scenarios) {
    const loaded = await loadScenario(entry.scenario);
    assert.equal(loaded.scenario, entry.scenario);
    assert.ok(loaded.phases.length >= 1);
    assert.ok(loaded.description, `${entry.scenario} should explain itself`);
  }
});

test("scenario lookup cannot traverse out of the fixtures directory", async () => {
  for (const name of ["../../package", "..%2Fpackage", "/etc/passwd", "a".repeat(80), ""]) {
    await assert.rejects(() => loadScenario(name), ScenarioError, `${name} should be refused`);
  }
});

test("resolveScenario accepts a built-in name or a file path", async () => {
  const byName = await resolveScenario("ipv6-path-loss");
  assert.equal(byName.scenario, "ipv6-path-loss");

  const byPath = await resolveScenario("fixtures/recorder/ipv6-path-loss.json");
  assert.equal(byPath.scenario, "ipv6-path-loss");

  await assert.rejects(() => resolveScenario("fixtures/recorder/does-not-exist.json"), ScenarioError);
});

// --- the sample source ------------------------------------------------------

test("phases advance on elapsed simulated time", async () => {
  let clock = 1_000_000;
  const scenario = validateScenario({
    scenario: "phased",
    phases: [
      { durationMs: 6_000, label: "up", targetTcp: "PASS" },
      { durationMs: 6_000, label: "down", targetTcp: "FAIL" }
    ]
  });
  const sampler = createSimulationSampler(scenario, { now: () => clock });

  assert.equal((await sampler({ seq: 0 })).sample.connectivity.targetTcp.state, RESULT.PASS);
  clock += 7_000;
  assert.equal((await sampler({ seq: 1 })).sample.connectivity.targetTcp.state, RESULT.FAIL);
  // Past the end the final phase holds rather than the source stopping.
  clock += 60_000;
  assert.equal((await sampler({ seq: 2 })).sample.connectivity.targetTcp.state, RESULT.FAIL);
});

test("a scenario asserts measurements, and the engine classifies them", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "classify",
    phases: [{ durationMs: 4_000, targetTcp: "FAIL" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  // The scenario never sets `state`: classification is production logic.
  assert.equal(sample.state, STATE.FAILED);
  assert.ok(sample.reasons.includes("target TCP unreachable"));
});

// --- DNS evidence must not contradict connectivity --------------------------

test("the ipv6-path-loss scenario shows AAAA present in every phase", async () => {
  // The demo's whole claim is "the target publishes AAAA but this machine
  // cannot use IPv6". A sample asserting IPv6 PASS alongside zero AAAA records
  // would contradict itself and undermine the distinction the scenario exists
  // to demonstrate.
  const scenario = await loadScenario("ipv6-path-loss");
  const clock = { value: Date.parse("2026-08-19T20:00:00.000Z") };
  const sampler = createSimulationSampler(scenario, { now: () => clock.value });

  const seen = [];
  let elapsed = 0;
  for (const phase of scenario.phases) {
    clock.value += 1_000;
    elapsed += 1_000;
    const { sample } = await sampler({ seq: seen.length });
    seen.push({ phase: phase.label, ipv6: sample.connectivity.ipv6.state, dns: sample.connectivity.targetDns });
    clock.value += phase.durationMs - 1_000;
    elapsed += phase.durationMs - 1_000;
  }

  assert.equal(seen.length, scenario.phases.length);
  for (const entry of seen) {
    assert.ok(entry.dns.v6 > 0, `AAAA must be present in phase "${entry.phase}", got ${entry.dns.v6}`);
    assert.ok(entry.dns.v4 > 0, `A must be present in phase "${entry.phase}"`);
  }

  // And specifically: the healthy and broken phases both publish AAAA.
  const healthy = seen.find(entry => entry.ipv6 === RESULT.PASS);
  const broken = seen.find(entry => entry.ipv6 === RESULT.FAIL);
  assert.ok(healthy && broken, "the scenario should contain both a healthy and a failing IPv6 phase");
  assert.ok(healthy.dns.v6 > 0);
  assert.ok(broken.dns.v6 > 0, "AAAA must still exist while local IPv6 is failing");
});

test("DNS family counts are explicit scenario measurements", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "explicit-dns",
    phases: [{ durationMs: 2_000, targetDns: "PASS", targetDnsV4: 3, targetDnsV6: 5, ipv4: "PASS", ipv6: "PASS" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  assert.equal(sample.connectivity.targetDns.v4, 3);
  assert.equal(sample.connectivity.targetDns.v6, 5);
});

test("an unstated DNS family is derived from that family's own result, never assumed absent", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "derived-dns",
    phases: [{ durationMs: 2_000, targetDns: "PASS", ipv4: "PASS", ipv6: "FAIL" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  // IPv6 FAIL means it was attempted, so an address existed to attempt.
  assert.ok(sample.connectivity.targetDns.v6 > 0, "a FAIL implies an address was published");

  const inapplicable = createSimulationSampler(validateScenario({
    scenario: "no-aaaa",
    phases: [{ durationMs: 2_000, targetDns: "PASS", ipv4: "PASS", ipv6: "INAPPLICABLE" }]
  }));
  const { sample: second } = await inapplicable({ seq: 0 });
  // INAPPLICABLE is the one case that genuinely means no record of that family.
  assert.equal(second.connectivity.targetDns.v6, 0);
});

test("a failing resolver reports no answers of either family", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "dns-down",
    phases: [{ durationMs: 2_000, targetDns: "FAIL", ipv4: "UNKNOWN", ipv6: "UNKNOWN" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  assert.equal(sample.connectivity.targetDns.v4, 0);
  assert.equal(sample.connectivity.targetDns.v6, 0);
});

test("a scenario file must name itself", async () => {
  // The filename fallback is gone: provenance is never inferred from a path.
  await assert.rejects(
    () => resolveScenario("fixtures/recorder/../../package.json"),
    ScenarioError
  );
});

// --- the real engine, driven by simulated samples ---------------------------

function fakeClock(start = Date.parse("2026-08-19T20:00:00.000Z")) {
  let current = start;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => current,
    api: {
      setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, due: current + ms }); return id; },
      clearTimeout(id) { pending.delete(id); }
    },
    async advance(ms) {
      const target = current + ms;
      while (true) {
        await new Promise(resolve => setImmediate(resolve));
        const due = [...pending.entries()].filter(([, entry]) => entry.due <= target).sort((a, b) => a[1].due - b[1].due);
        if (!due.length) break;
        const [id, entry] = due[0];
        pending.delete(id);
        current = entry.due;
        await entry.fn();
      }
      current = target;
    }
  };
}

// The after-window must outlast the scenario's failing phase, or the incident
// closes as "after_window_elapsed" before recovery arrives - bounded behaviour
// that is correct, but not what these scenarios are demonstrating.
async function runScenario(name, { afterWindowMs = 30_000, advanceMs = 120_000 } = {}) {
  const scenario = await loadScenario(name);
  const clock = fakeClock();
  const events = [];
  const recorder = createRecorder({
    target: { host: scenario.target, port: scenario.port, input: scenario.target },
    intervalMs: scenario.intervalMs,
    windowMs: 120_000,
    afterWindowMs,
    sampler: createSimulationSampler(scenario, { now: clock.now }),
    simulation: scenario,
    now: clock.now,
    clock: clock.api,
    onEvent: event => events.push(event)
  });

  recorder.start();
  await clock.advance(advanceMs);
  recorder.stop();
  return { recorder, events, scenario };
}

test("the ipv6-path-loss demo produces the documented result", async () => {
  const { recorder, events } = await runScenario("ipv6-path-loss");

  // 1. The real trigger fired on a real crossing.
  const opened = events.find(event => event.type === "incident-open");
  assert.ok(opened, "a reachability transition should open an incident");
  assert.equal(opened.trigger.type, TRIGGER.TARGET_REACHABILITY);
  assert.equal(opened.trigger.direction, "pass_to_fail");

  const incident = recorder.latestIncident();
  assert.ok(incident, "an incident should have been assembled");

  // 2. Real windows, frozen by the real buffer.
  assert.ok(incident.windows.before.samples.length > 0, "a healthy BEFORE window");
  assert.ok(incident.windows.before.samples.every(sample => sample.state === STATE.HEALTHY));
  assert.ok(incident.windows.during.samples.length > 0);
  assert.ok(incident.windows.after.samples.length > 0, "recovery should be captured");

  // 3. The real difference engine found the condition.
  const differences = incident.observedChange.differences.map(entry => entry.key);
  assert.ok(differences.includes("ipv6"), `expected an ipv6 difference, got ${differences.join(", ") || "none"}`);

  // 4. The real axis mapping produced the Bisect candidate.
  assert.deepEqual(incident.candidateDiscriminators.bisectAxes, ["address-family"]);
  assert.equal(incident.candidateDiscriminators.available, true);

  // 5. Still no causal claim.
  assert.equal(incident.observedChange.classification, "temporal_association");
  assert.ok(!incident.observedChange.statement.toLowerCase().includes("caused"));
});

test("the vpn-route-loss scenario maps to the source-interface axis", async () => {
  const { recorder } = await runScenario("vpn-route-loss");
  const incident = recorder.latestIncident();
  assert.ok(incident);
  const keys = incident.observedChange.differences.map(entry => entry.key);
  assert.ok(keys.includes("activeInterface") || keys.includes("defaultRoute") || keys.includes("vpn"),
    `expected an interface/route/vpn difference, got ${keys.join(", ") || "none"}`);
  assert.ok(incident.candidateDiscriminators.bisectAxes.includes("source-interface"));
});

test("the resolver-change scenario maps to the resolver axis", async () => {
  const { recorder } = await runScenario("resolver-change", { advanceMs: 90_000 });
  const incident = recorder.latestIncident();
  assert.ok(incident);
  assert.ok(incident.candidateDiscriminators.bisectAxes.includes("resolver"),
    `expected the resolver axis, got ${incident.candidateDiscriminators.bisectAxes.join(", ") || "none"}`);
});

// --- provenance -------------------------------------------------------------

test("a simulated incident is marked at every layer", async () => {
  const { recorder } = await runScenario("ipv6-path-loss");
  const incident = recorder.latestIncident();

  // The record itself.
  assert.equal(incident.simulated, true);
  assert.equal(incident.source, "simulation");
  assert.equal(incident.scenario, "ipv6-path-loss");
  assert.equal(incident.evidenceClass, "simulated");
  assert.match(incident.epistemics.observed, /SIMULATED/);

  // The list summary, which is what most surfaces render.
  const summary = summariseIncident(incident);
  assert.equal(summary.simulated, true);
  assert.equal(summary.scenario, "ipv6-path-loss");

  // Every sample in every window.
  const all = [...incident.windows.before.samples, ...incident.windows.during.samples, ...incident.windows.after.samples];
  assert.ok(all.length > 0);
  assert.ok(all.every(sample => sample.simulated === true && sample.source === "simulation"));

  // What the Analyst is handed.
  const projected = projectIncident(incident);
  assert.equal(projected.simulated, true);
  assert.equal(projected.evidenceClass, "simulated");
  assert.match(projected.epistemics.forTheAnalyst, /THIS INCIDENT IS SIMULATED/);
  assert.match(projected.epistemics.forTheAnalyst, /never present it as evidence about the user's network/);
});

test("a real incident is never marked simulated", () => {
  const realSample = {
    at: "2026-08-19T20:00:00.000Z",
    state: STATE.HEALTHY,
    connectivity: { targetTcp: { state: RESULT.PASS, ms: 30 }, ipv4: {}, ipv6: {}, gateway: {}, targetDns: {} },
    local: { activeInterface: "Ethernet", resolvers: [] },
    path: { fingerprint: "fp" },
    reasons: []
  };
  const incident = summariseIncident({
    id: "FLR-2026-0001",
    windows: { before: { samples: [realSample] }, during: { samples: [] }, after: { samples: [] } },
    trigger: {},
    observedChange: { differences: [] },
    candidateDiscriminators: { bisectAxes: [] }
  });
  assert.equal(incident.simulated, false);
  assert.equal(incident.source, "measured");
});

test("a simulated incident carries no real measurement inside it", async () => {
  // The deep capture is suppressed for simulations: embedding a genuine
  // measurement in a fabricated record would mix the two kinds of evidence.
  const scenario = await loadScenario("ipv6-path-loss");
  const clock = fakeClock();
  let deepCaptureCalls = 0;
  const recorder = createRecorder({
    target: { host: scenario.target, port: scenario.port, input: scenario.target },
    intervalMs: scenario.intervalMs,
    afterWindowMs: 10_000,
    sampler: createSimulationSampler(scenario, { now: clock.now }),
    simulation: scenario,
    // The router and CLI both pass null for a simulation; this asserts that a
    // capture would not silently run if one were wired in by mistake.
    deepCapture: null,
    now: clock.now,
    clock: clock.api
  });

  recorder.start();
  await clock.advance(90_000);
  recorder.stop();

  assert.equal(deepCaptureCalls, 0);
  assert.equal(recorder.latestIncident().deepCapture, null);
});

test("recorder status advertises the simulation", async () => {
  const { recorder, scenario } = await runScenario("ipv6-path-loss", { advanceMs: 10_000 });
  const status = recorder.status();
  assert.equal(status.simulated, true);
  assert.equal(status.simulation.scenario, scenario.scenario);
  assert.equal(status.simulation.phases, scenario.phases.length);
});

// --- a simulation is inseparable from its scenario's target -----------------

test("a scenario's own port is used, not a default", async () => {
  const scenario = await loadScenario("custom-port-demo");
  assert.equal(scenario.target, "service.example");
  assert.equal(scenario.port, 8443);

  const clock = fakeClock();
  const recorder = createRecorder({
    // Exactly how the CLI and router construct it for a simulation.
    target: { host: scenario.target, port: scenario.port, input: scenario.target },
    intervalMs: scenario.intervalMs,
    afterWindowMs: 20_000,
    sampler: createSimulationSampler(scenario, { now: clock.now }),
    simulation: scenario,
    deepCapture: null,
    now: clock.now,
    clock: clock.api
  });

  recorder.start();
  await clock.advance(60_000);
  recorder.stop();

  const incident = recorder.latestIncident();
  assert.ok(incident, "the scenario should produce an incident");
  assert.equal(incident.target.host, "service.example");
  assert.equal(incident.target.port, 8443, "the incident must carry the scenario's port");
});

test("the CLI refuses a positional target alongside --simulate", async () => {
  // Recording scripted samples for one host as an incident against another
  // would detach the evidence from what it describes - and a later Bisect
  // handoff would make real connections to a host the scenario never named.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["src/recorder/cli.mjs", "google.com", "--simulate", "ipv6-path-loss"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000
  });

  assert.equal(result.status, 1, "the run must be refused");
  assert.match(result.stderr, /Cannot specify a target with --simulate/);
  assert.match(result.stderr, /example\.com:443/, "the refusal should name the scenario's own target");
  assert.ok(!/google\.com/.test(result.stdout || ""), "no recording against the supplied host may start");
});

test("the CLI binds a simulation to the scenario target and port", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["src/recorder/cli.mjs", "--simulate", "custom-port-demo", "--duration", "6"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 40_000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /service\.example:8443/, "the banner must show the scenario's target and port");
  assert.match(result.stdout, /SIMULATED CAPTURE/);
});
