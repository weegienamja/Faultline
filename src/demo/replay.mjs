// Deterministic replay of a recorded investigation.
//
// The hosted demo has to show the half of Faultline that a Vercel Function
// genuinely cannot do: endpoint capture, route and resolver observation, and an
// isolation experiment that varies a local condition. The dishonest way to do
// that is to hand-write some JSON that looks like a result. This module does
// the opposite - it runs the REAL engines and replaces only the source of
// evidence, at the same two seams the product already provides for exactly this
// purpose:
//
//   Flight Recorder   `sampler`      already swapped by src/recorder/simulate.mjs
//   Network Bisect    `trialRunner`  already a parameter of isolate()
//
// Everything downstream is production code: the ring buffer, trigger detection,
// cooldown, freeze, BEFORE/DURING/AFTER assembly, the difference engine, axis
// mapping, hypothesis formation, the adaptive planner, interleaved A/B
// confirmation and verdict classification. A demo that exercised a parallel
// implementation would prove nothing about the one that runs for real.
//
// TIME is the other substitution. A scenario plays out over a minute or more of
// wall clock, which no HTTP request should wait for, so the recorder is driven
// by a virtual clock: `now` and `clock` are already injectable parameters of
// createRecorder. Sixty seconds of recorded network behaviour resolves in
// milliseconds, and the arithmetic the engine performs is identical.
//
// PROVENANCE. Every sample is stamped `simulated: true` by the simulation
// sampler, and buildIncident derives the incident's own provenance from the
// samples rather than from anything a caller says. A replayed incident cannot
// be mistaken for a measured one at any layer.

import { isolate } from "../bisect/adaptive.mjs";
import { IFACE, ROUTE } from "../bisect/interfaces.mjs";
import { planFromAssignment, STAGE } from "../bisect/probe.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { createRecorder } from "../recorder/recorder.mjs";
import { createSimulationSampler, loadScenario } from "../recorder/simulate.mjs";

/** A fixed origin, so a replay produces the same timestamps on every request. */
const REPLAY_EPOCH = Date.UTC(2026, 2, 17, 14, 20, 0);

/** Long enough for every built-in scenario's recovery to land inside it. */
const AFTER_WINDOW_MS = 30_000;

/** Hard ceiling on virtual ticks, so a malformed scenario cannot spin. */
const MAX_TICKS = 400;

/** Let queued promises settle before the virtual clock moves again. */
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/**
 * Drive the real Flight Recorder through a scenario on a virtual clock.
 *
 * @param {object} scenario  a validated scenario from src/recorder/simulate.mjs
 * @param {object} [options]
 * @param {string} [options.id]  stable incident reference for this demo
 * @returns {Promise<object>} the closed incident, built by buildIncident()
 */
export async function replayIncident(scenario, { id = null } = {}) {
  let virtualNow = REPLAY_EPOCH;
  let timers = [];
  let timerSeq = 0;

  const clock = {
    setTimeout(fn, ms) {
      const timer = { id: (timerSeq += 1), at: virtualNow + Number(ms || 0), fn };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers = timers.filter(entry => entry !== timer);
    }
  };
  const now = () => virtualNow;

  const recorder = createRecorder({
    target: parseLiveTarget(scenario.target, scenario.port),
    intervalMs: scenario.intervalMs,
    windowMs: 3 * 60_000,
    afterWindowMs: AFTER_WINDOW_MS,
    cooldownMs: 60_000,
    sampler: createSimulationSampler(scenario, { now }),
    simulation: scenario,
    // A simulated incident must never contain a real measurement, and a hosted
    // runtime must never make one on a visitor's behalf here.
    deepCapture: null,
    publicIpUrl: null,
    now,
    clock
  });

  recorder.start();
  await settle();

  const deadline = REPLAY_EPOCH + scenario.totalMs + AFTER_WINDOW_MS + 60_000;
  let ticks = 0;
  while (timers.length && virtualNow < deadline && ticks < MAX_TICKS) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    virtualNow = next.at;
    next.fn();
    await settle();
    ticks += 1;
    if (recorder.latestIncident()?.closedAt) break;
  }

  // Stopping closes an incident that is still open, so a scenario that never
  // recovers still yields a usable record rather than nothing.
  recorder.stop();
  await settle();

  const incident = recorder.latestIncident();
  if (!incident) {
    throw new Error(`Scenario ${scenario.scenario} produced no incident.`);
  }
  // The recorder mints a process-sequential FLR-YYYY-NNNN reference. A demo
  // needs a stable one that is the same on every Function instance, and that
  // can never be confused with a reference a real capture produced.
  return {
    ...incident,
    id: id || incident.id,
    replay: { ticks, virtualEpoch: new Date(REPLAY_EPOCH).toISOString() }
  };
}

// ---------------------------------------------------------------------------
// Network Bisect replay
// ---------------------------------------------------------------------------

/**
 * A scripted trial source with the same signature as runTrial().
 *
 * `world` is a model of how the RECORDED endpoint behaved, expressed as a pure
 * function of the connection plan the real planner produced. It never sees the
 * hypothesis set, the score, or which experiment is running - only the actual
 * connection parameters - so it cannot steer the engine towards a conclusion.
 * The engine explores; the world answers.
 *
 * @param {(plan: object) => {verdict: string, stage?: string, reason?: string}} world
 */
export function createScriptedTrialRunner(world) {
  return async function scriptedTrial(target, assignment, _options = {}) {
    const { plan, blocked } = planFromAssignment(target, assignment);
    if (blocked) return { verdict: "inapplicable", stage: null, reason: blocked, stages: {}, plan: null };

    const outcome = world(plan) || { verdict: "fail", stage: STAGE.TCP, reason: "no scripted outcome" };
    return {
      verdict: outcome.verdict,
      stage: outcome.verdict === "pass" ? null : (outcome.stage || STAGE.TCP),
      reason: outcome.reason || null,
      // The stage map mirrors runTrial's shape so the transcript and any
      // consumer of the report read identically to a measured run.
      stages: outcome.stages || {},
      plan
    };
  };
}

/**
 * Run the real adaptive isolation engine against a scripted world.
 *
 * `answerSets` and `interfaceModel` are already parameters of isolate() - they
 * exist so a caller can supply DNS answers and an interface model rather than
 * having the engine read the local machine. Here they describe the recorded
 * endpoint.
 */
export async function replayBisect({ target, port = 443, world, answerSets, interfaces = [], resolvers, axes, repeat = 3, confirmPairs = 3 }) {
  // A URL rather than "host:port": parseLiveTarget treats a bare "host:port"
  // string as a hostname and rejects it.
  const url = `${port === 80 ? "http" : "https"}://${target}${port === 80 || port === 443 ? "" : `:${port}`}/`;
  const report = await isolate(url, {
    repeat,
    confirmPairs,
    resolvers,
    axes,
    answerSets,
    interfaceModel: { interfaces },
    trialRunner: createScriptedTrialRunner(world)
  });

  // The engine's own evidence note says "a real connection made from this
  // machine". That is true when it runs for real and false here, so it is
  // replaced rather than left to be read as a measurement claim.
  return {
    ...report,
    simulated: true,
    evidenceClass: "simulated",
    source: "replay",
    evidence: {
      observed: "REPLAYED. Each trial outcome comes from the recorded scenario's endpoint behaviour, not from a connection made by this deployment.",
      deterministic: report.evidence?.deterministic
        ?? "Experiment selection, hypothesis updates and the verdict follow fixed rules with no probabilities.",
      note: "The isolation engine, planner, A/B confirmation and verdict classification are the production implementation. Only the source of each trial result is scripted."
    }
  };
}

/** Interface descriptors for a scripted world, in the shape isolate() expects. */
export function scriptedInterface({ name, address, classification = IFACE.ETHERNET, hasRoute = true, ownsDefaultRoute = false, isBestDefault = false, routeReason = null }) {
  return {
    name,
    address,
    classification,
    routeSupport: hasRoute ? ROUTE.HAS_ROUTE : ROUTE.NO_ROUTE,
    routeReason,
    ownsDefaultRoute,
    isBestDefault
  };
}

export { IFACE, REPLAY_EPOCH, STAGE };

/** Convenience for the catalogue: load a built-in scenario by name. */
export function loadDemoScenario(name) {
  return loadScenario(name);
}
