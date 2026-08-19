// Flight Recorder simulation.
//
// A simulation is a SAMPLE SOURCE, not a second recorder. It plugs in at the
// same boundary the real sampler uses:
//
//   real sampler ────────┐
//                        ▼
//                   recorder engine
//                        ▲
//   simulation source ───┘
//
// Everything downstream is production code: the ring buffer, threshold
// crossing, cooldown, trigger selection, freeze, BEFORE/DURING/AFTER assembly,
// the difference engine, axis mapping and the Bisect handoff. That is the whole
// point - a demo that exercised a parallel implementation would prove nothing
// about the one that runs for real.
//
// PROVENANCE IS NON-NEGOTIABLE. Every simulated sample carries
// `source: "simulation"`, `simulated: true` and the scenario name, and the
// incident builder propagates that to the record. A simulated incident must be
// impossible to mistake for a real one at any point downstream - in the UI, in
// the store, in an evidence package, or in what the Analyst is told.

import { readFile, readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pathFingerprint, classifySample, NOT_SAMPLED, UNKNOWN_STATE } from "./sample.mjs";
import { RESULT } from "../bisect/results.mjs";

const fixturesDir = fileURLToPath(new URL("../../fixtures/recorder/", import.meta.url));

/** Built-in scenario names. A name is never used to build a path unchecked. */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** States a scenario phase may assert. Anything else is rejected. */
const STATES = new Set([RESULT.PASS, RESULT.FAIL, RESULT.INAPPLICABLE, RESULT.UNSTABLE, UNKNOWN_STATE, NOT_SAMPLED]);

const MAX_PHASES = 20;
const MAX_PHASE_MS = 10 * 60_000;
const MAX_TOTAL_MS = 30 * 60_000;

export class ScenarioError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioError";
    this.statusCode = 400;
  }
}

// --- validation -------------------------------------------------------------
//
// A scenario file is untrusted input read from disk, so every field is checked
// and copied into a fresh object. Nothing from the file is spread into a sample.

const text = (value, field, max = 120) => {
  if (value === undefined || value === null) return null;
  const string = String(value);
  if (string.length > max) throw new ScenarioError(`Scenario field "${field}" is too long.`);
  return string;
};

const state = (value, field) => {
  if (value === undefined || value === null) return null;
  const string = String(value).toUpperCase();
  if (!STATES.has(string)) throw new ScenarioError(`Scenario field "${field}" must be one of ${[...STATES].join(", ")}.`);
  return string;
};

const number = (value, field, { min = 0, max = 600_000 } = {}) => {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw new ScenarioError(`Scenario field "${field}" must be a number between ${min} and ${max}.`);
  }
  return numeric;
};

function validateRoute(value, index) {
  if (!value || typeof value !== "object") return null;
  return {
    destination: text(value.destination, `phases[${index}].route.destination`, 60) || "0.0.0.0/0",
    nextHop: text(value.nextHop, `phases[${index}].route.nextHop`, 60),
    interfaceAlias: text(value.interfaceAlias, `phases[${index}].route.interfaceAlias`, 80),
    metric: number(value.metric, `phases[${index}].route.metric`, { max: 100_000 })
  };
}

export function validateScenario(input) {
  if (!input || typeof input !== "object") throw new ScenarioError("A scenario object is required.");

  const name = text(input.scenario, "scenario", 60);
  if (!name || !SCENARIO_NAME.test(name)) {
    throw new ScenarioError("Scenario name must be lowercase letters, digits and hyphens.");
  }
  if (!Array.isArray(input.phases) || !input.phases.length) {
    throw new ScenarioError("A scenario needs at least one phase.");
  }
  if (input.phases.length > MAX_PHASES) {
    throw new ScenarioError(`A scenario may have at most ${MAX_PHASES} phases.`);
  }

  let total = 0;
  const phases = input.phases.map((phase, index) => {
    if (!phase || typeof phase !== "object") throw new ScenarioError(`phases[${index}] must be an object.`);
    const durationMs = number(phase.durationMs, `phases[${index}].durationMs`, { min: 1_000, max: MAX_PHASE_MS });
    if (!durationMs) throw new ScenarioError(`phases[${index}].durationMs is required.`);
    total += durationMs;

    return {
      label: text(phase.label, `phases[${index}].label`, 120) || `phase ${index + 1}`,
      note: text(phase.note, `phases[${index}].note`, 300),
      durationMs,
      targetTcp: state(phase.targetTcp, `phases[${index}].targetTcp`) || RESULT.PASS,
      targetTcpMs: number(phase.targetTcpMs, `phases[${index}].targetTcpMs`, { max: 60_000 }),
      targetTcpError: text(phase.targetTcpError, `phases[${index}].targetTcpError`, 60),
      targetDns: state(phase.targetDns, `phases[${index}].targetDns`) || RESULT.PASS,
      ipv4: state(phase.ipv4, `phases[${index}].ipv4`) || RESULT.PASS,
      ipv6: state(phase.ipv6, `phases[${index}].ipv6`) || RESULT.INAPPLICABLE,
      gatewayMs: number(phase.gatewayMs, `phases[${index}].gatewayMs`, { max: 10_000 }),
      gatewayLossPct: number(phase.gatewayLossPct, `phases[${index}].gatewayLossPct`, { max: 100 }),
      activeInterface: text(phase.activeInterface, `phases[${index}].activeInterface`, 80),
      gateway: text(phase.gateway, `phases[${index}].gateway`, 60),
      route: validateRoute(phase.route, index),
      resolvers: Array.isArray(phase.resolvers)
        ? phase.resolvers.slice(0, 8).map((entry, position) => text(entry, `phases[${index}].resolvers[${position}]`, 60)).filter(Boolean)
        : [],
      wifiSsid: text(phase.wifiSsid, `phases[${index}].wifiSsid`, 64),
      wifiBssid: text(phase.wifiBssid, `phases[${index}].wifiBssid`, 32),
      vpn: phase.vpn === true,
      vpnAdapters: Array.isArray(phase.vpnAdapters)
        ? phase.vpnAdapters.slice(0, 4).map((entry, position) => text(entry, `phases[${index}].vpnAdapters[${position}]`, 80)).filter(Boolean)
        : [],
      publicIp: text(phase.publicIp, `phases[${index}].publicIp`, 45),
      resolvedAddress: text(phase.resolvedAddress, `phases[${index}].resolvedAddress`, 45)
    };
  });

  if (total > MAX_TOTAL_MS) throw new ScenarioError("A scenario may not exceed 30 minutes in total.");

  return {
    scenario: name,
    title: text(input.title, "title", 120) || name,
    description: text(input.description, "description", 600),
    target: text(input.target, "target", 260) || "example.com",
    port: number(input.port, "port", { min: 1, max: 65_535 }) || 443,
    intervalMs: number(input.intervalMs, "intervalMs", { min: 1_000, max: 30_000 }) || 2_000,
    totalMs: total,
    phases
  };
}

// --- loading ----------------------------------------------------------------

export async function listScenarios() {
  try {
    const files = await readdir(fixturesDir);
    const scenarios = [];
    for (const file of files) {
      if (extname(file) !== ".json") continue;
      try {
        const scenario = validateScenario(JSON.parse(await readFile(resolve(fixturesDir, file), "utf8")));
        scenarios.push({
          scenario: scenario.scenario,
          title: scenario.title,
          description: scenario.description,
          target: scenario.target,
          durationMs: scenario.totalMs,
          phases: scenario.phases.length
        });
      } catch {
        // A malformed fixture is skipped rather than breaking discovery.
      }
    }
    return scenarios.sort((a, b) => a.scenario.localeCompare(b.scenario));
  } catch {
    return [];
  }
}

/**
 * Load a built-in scenario by name.
 * The name is pattern-checked and joined to a fixed directory, so it can never
 * traverse out of it - this is reachable from the HTTP API.
 */
export async function loadScenario(name) {
  const safe = String(name ?? "").trim();
  if (!SCENARIO_NAME.test(safe)) throw new ScenarioError(`Unknown simulation scenario "${safe.slice(0, 40)}".`);
  try {
    return validateScenario(JSON.parse(await readFile(resolve(fixturesDir, `${safe}.json`), "utf8")));
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    throw new ScenarioError(`Unknown simulation scenario "${safe}".`);
  }
}

/**
 * Load a scenario from an explicit file path.
 * CLI only: the operator chose the file. The HTTP API accepts built-in names
 * only, so a request can never name a path on the server's filesystem.
 */
export async function loadScenarioFile(path) {
  try {
    const scenario = validateScenario(JSON.parse(await readFile(resolve(path), "utf8")));
    // Fall back to the filename so an unnamed file still has provenance.
    return { ...scenario, scenario: scenario.scenario || basename(path, ".json") };
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    throw new ScenarioError(`Could not read simulation scenario at ${path}.`);
  }
}

/** Resolve either form: a built-in name, or a path to a .json file. */
export async function resolveScenario(value) {
  const input = String(value ?? "").trim();
  if (!input) throw new ScenarioError("A simulation scenario is required.");
  return input.endsWith(".json") || input.includes("/") || input.includes("\\")
    ? loadScenarioFile(input)
    : loadScenario(input);
}

// --- the sample source ------------------------------------------------------

/**
 * Build a sampler with the same signature as `takeSample`.
 *
 * Phases advance on elapsed simulated time, so the engine's real interval,
 * cooldown and after-window arithmetic all apply unchanged.
 */
export function createSimulationSampler(scenario, { now = () => Date.now() } = {}) {
  const validated = scenario.phases ? scenario : validateScenario(scenario);
  let startedAt = null;

  function phaseAt(elapsedMs) {
    let boundary = 0;
    for (const phase of validated.phases) {
      boundary += phase.durationMs;
      if (elapsedMs < boundary) return phase;
    }
    // Past the end: hold the final phase so the recorder does not stop abruptly.
    return validated.phases[validated.phases.length - 1];
  }

  return async function simulatedSampler({ seq = 0 } = {}) {
    const at = now();
    if (startedAt === null) startedAt = at;
    const elapsedMs = at - startedAt;
    const phase = phaseAt(elapsedMs);
    const iso = new Date(at).toISOString();

    const targetTcp = phase.targetTcp === RESULT.PASS
      ? { state: RESULT.PASS, ms: phase.targetTcpMs ?? 30 }
      : phase.targetTcp === RESULT.FAIL
        ? { state: RESULT.FAIL, error: phase.targetTcpError || "ETIMEDOUT" }
        : { state: phase.targetTcp };

    const family = (value, ms) => value === RESULT.PASS
      ? { state: RESULT.PASS, ms: ms ?? 30 }
      : value === RESULT.FAIL
        ? { state: RESULT.FAIL, error: phase.targetTcpError || "ENETUNREACH" }
        : { state: value, reason: value === RESULT.INAPPLICABLE ? "the target publishes no address of this family" : null };

    const sample = {
      seq,
      at: iso,
      tier: "simulated",
      // Provenance, on every single sample.
      source: "simulation",
      simulated: true,
      scenario: validated.scenario,
      phase: phase.label,
      local: {
        observedAt: iso,
        carriedForward: false,
        supported: true,
        activeInterface: phase.activeInterface,
        gateway: phase.gateway,
        route: phase.route,
        resolvers: phase.resolvers,
        wifi: phase.wifiSsid || phase.wifiBssid ? { ssid: phase.wifiSsid, bssid: phase.wifiBssid } : null,
        vpn: { active: phase.vpn, adapters: phase.vpnAdapters },
        interfaces: []
      },
      connectivity: {
        ipv4: family(phase.ipv4),
        ipv6: family(phase.ipv6),
        gateway: phase.gatewayMs === null && phase.gatewayLossPct === null
          ? { state: NOT_SAMPLED }
          : { state: RESULT.PASS, averageMs: phase.gatewayMs ?? 2, lossPct: phase.gatewayLossPct ?? 0, jitterMs: 0 },
        targetDns: { state: phase.targetDns, v4: phase.targetDns === RESULT.PASS ? 1 : 0, v6: 0, error: null },
        targetTcp,
        contract: null
      },
      path: {
        publicIp: phase.publicIp ? { value: phase.publicIp, observedAt: iso, carriedForward: false } : null,
        resolvedAddress: phase.resolvedAddress,
        resolvedAddresses: phase.resolvedAddress ? [phase.resolvedAddress] : [],
        fingerprint: pathFingerprint({
          activeInterface: phase.activeInterface,
          gateway: phase.gateway,
          route: phase.route,
          resolvers: phase.resolvers,
          publicIp: phase.publicIp
        })
      }
    };

    // Classified by the production rules, not by the scenario: a scenario
    // asserts measurements, never conclusions.
    const classified = classifySample(sample);
    sample.state = classified.state;
    sample.reasons = classified.reasons;

    return { sample, carried: null };
  };
}

export { SCENARIO_NAME, fixturesDir };
