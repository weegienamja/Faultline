// Flight Recorder CLI.
//
//   npm run recorder -- example.com
//   npm run recorder -- example.com --interval 3 --window 300
//   npm run recorder -- mark
//
// Two modes. Without `mark` it records in this process and prints a live
// one-line-per-sample view. With `mark` it asks a running control plane to
// capture an incident now - the case where the engineer sees the problem before
// a threshold does.
//
// The local mode needs no server, matching `npm run bisect`: the fastest path
// to evidence should not require standing anything up.

import { createRecorder, RECORDER_STATE } from "./recorder.mjs";
import { createDeepCapture } from "./deep-capture.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { getConnectivityContract } from "../contracts/registry.mjs";
import { createSimulationSampler, listScenarios, resolveScenario } from "./simulate.mjs";
import { RESULT } from "../bisect/results.mjs";

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) args.flags[key] = true;
      else {
        args.flags[key] = next;
        index += 1;
      }
    } else {
      args._.push(value);
    }
  }
  return args;
}

const pad = (value, width) => String(value ?? "").padEnd(width);
const time = at => new Date(at).toISOString().slice(11, 19);

function stateMark(state) {
  return state === "healthy" ? "  ok " : state === "degraded" ? " warn" : state === "failed" ? " FAIL" : "  ?  ";
}

function renderSample(sample) {
  const tcp = sample.connectivity.targetTcp;
  const reach = tcp.state === RESULT.PASS ? `PASS ${tcp.ms} ms` : tcp.state === RESULT.FAIL ? `FAIL ${tcp.error || ""}` : tcp.state;
  const v6 = sample.connectivity.ipv6.state;
  const gateway = sample.connectivity.gateway?.state === RESULT.PASS
    ? `${sample.connectivity.gateway.averageMs} ms`
    : sample.connectivity.gateway?.state === RESULT.FAIL ? "FAIL" : "—";
  return `${time(sample.at)} ${stateMark(sample.state)}  ${pad(reach, 22)} v6 ${pad(v6, 13)} gw ${pad(gateway, 8)} ${sample.local.activeInterface || ""}`;
}

function renderIncident(incident) {
  const lines = [];
  lines.push("");
  lines.push(`INCIDENT  ${incident.id}`);
  if (incident.simulated) {
    lines.push("");
    lines.push(`*** SIMULATED — scenario "${incident.scenario}". Not a measurement of any real network. ***`);
  }
  lines.push("");
  lines.push(`Target      ${incident.target.host}:${incident.target.port}`);
  lines.push(`Triggered   ${time(incident.trigger.at)}`);
  lines.push(`            ${incident.trigger.summary}`);
  lines.push("");

  const section = (title, window) => {
    if (!window.samples.length) return;
    lines.push("─".repeat(60));
    lines.push("");
    lines.push(title);
    lines.push("");
    for (const sample of window.samples.slice(-4)) lines.push(`  ${renderSample(sample)}`);
    lines.push("");
  };

  section("BEFORE", incident.windows.before);
  section("DURING", incident.windows.during);

  if (incident.deepCapture?.available) {
    lines.push("  DEEP CAPTURE");
    for (const stage of incident.deepCapture.stages || []) {
      lines.push(`    ${pad(stage.name, 8)} ${stage.state}`);
    }
    if (incident.deepCapture.external) {
      lines.push(`    ${pad("External", 8)} ${incident.deepCapture.external.meaning || incident.deepCapture.external.state}`);
    }
    lines.push("");
  }

  section("AFTER", incident.windows.after);

  lines.push("─".repeat(60));
  lines.push("");
  lines.push("OBSERVED CHANGE");
  lines.push("");
  if (incident.observedChange.comparable) {
    lines.push(wrap(incident.observedChange.statement, 62, "  "));
    lines.push("");
    // The qualification lives on the record, not inside the statement.
    lines.push(wrap(incident.observedChange.note, 62, "  "));
    if (incident.observedChange.differences.length) {
      lines.push("");
      lines.push("  Differences between the healthy and failing windows:");
      for (const difference of incident.observedChange.differences) {
        lines.push(`    ${pad(difference.label, 26)} ${difference.from}  →  ${difference.to}`);
      }
    }
  } else {
    lines.push(wrap(incident.observedChange.reason, 62, "  "));
  }

  const candidates = incident.candidateDiscriminators;
  if (candidates?.available) {
    lines.push("");
    lines.push("CANDIDATE CHANGED CONDITIONS");
    lines.push("");
    for (const candidate of candidates.testable) lines.push(`    ${candidate.condition}   (axis: ${candidate.axis})`);
    lines.push("");
    lines.push(wrap(candidates.invitation, 62, "  "));
    lines.push("");
    lines.push(`    npm run bisect -- ${incident.target.host}`);
  }
  if (candidates?.untestable?.length) {
    lines.push("");
    lines.push("  Observed but not testable by Network Bisect:");
    for (const entry of candidates.untestable) lines.push(`    ${entry.condition}`);
  }

  lines.push("");
  return lines.join("\n");
}

function wrap(text, width, indent = "") {
  if (!text) return "";
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      lines.push(indent + line.trim());
      line = "";
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(indent + line.trim());
  return lines.join("\n");
}

async function remoteMark(args) {
  const base = args.flags.server || process.env.FAULTLINE_URL || "http://127.0.0.1:3000";
  const token = args.flags.token || process.env.FAULTLINE_ADMIN_TOKEN;
  if (!token) {
    console.error("An admin token is required. Set FAULTLINE_ADMIN_TOKEN or pass --token.");
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/api/recorder/mark`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note: typeof args.flags.note === "string" ? args.flags.note : null })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(payload.error || `Mark failed with HTTP ${response.status}.`);
      process.exitCode = 1;
      return;
    }
    console.log("Capture requested. The incident will be assembled on the next sample.");
  } catch (error) {
    console.error(`Could not reach the Faultline control plane at ${base}.`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args._[0] === "mark") return remoteMark(args);

  // A simulation may be given a built-in name or a path to a scenario file.
  const simulation = args.flags.simulate && args.flags.simulate !== true
    ? await resolveScenario(String(args.flags.simulate))
    : null;

  if (args.flags.simulate === true) {
    const scenarios = await listScenarios();
    console.error("Usage: npm run recorder -- --simulate <scenario|path-to.json>");
    console.error("");
    console.error("Built-in scenarios:");
    for (const entry of scenarios) console.error(`  ${entry.scenario.padEnd(20)} ${entry.title}`);
    process.exitCode = 1;
    return;
  }

  // A simulation is inseparable from its scenario's target and port. Accepting
  // a positional target alongside --simulate would let the scripted samples for
  // one host be recorded as an incident against another - and a later Bisect
  // handoff would then make real connections to a target the scenario never
  // described. Refused rather than silently ignored, so CLI and API semantics
  // stay identical.
  if (simulation && args._[0]) {
    console.error("Cannot specify a target with --simulate.");
    console.error(`The scenario defines its target and port (${simulation.target}:${simulation.port}).`);
    process.exitCode = 1;
    return;
  }

  const targetInput = simulation ? simulation.target : args._[0];
  if (!targetInput) {
    console.error("Usage: npm run recorder -- <target> [--interval 3] [--window 300] [--contract basic-reachability]");
    console.error("       npm run recorder -- --simulate <scenario|path-to.json>");
    console.error("       npm run recorder -- mark [--note \"...\"]");
    process.exitCode = 1;
    return;
  }

  const target = simulation
    ? parseLiveTarget(simulation.target, simulation.port)
    : parseLiveTarget(targetInput);
  const contract = args.flags.contract ? getConnectivityContract(String(args.flags.contract)) : null;
  const intervalMs = args.flags.interval
    ? Math.min(Math.max(Number(args.flags.interval) * 1000, 2_000), 30_000)
    : simulation?.intervalMs ?? 3_000;
  const windowMs = Math.min(Math.max((Number(args.flags.window) || 180) * 1000, 60_000), 600_000);

  console.log("");
  if (simulation) {
    // Impossible to miss, and repeated on the incident record itself.
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  SIMULATED CAPTURE - NOT A REAL MEASUREMENT              ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("");
    console.log(`Scenario    ${simulation.scenario} — ${simulation.title}`);
    if (simulation.description) console.log(wrap(simulation.description, 58, "            ").trimStart());
    console.log(`Phases      ${simulation.phases.map(phase => phase.label).join(" → ")}`);
    console.log("");
  }
  console.log(`Faultline Flight Recorder  ${target.host}:${target.port}`);
  console.log(`Sampling every ${intervalMs / 1000}s · rolling window ${Math.round(windowMs / 1000)}s in memory · closed incidents persist`);
  if (contract) console.log(`Contract: ${contract.name}`);
  console.log("Press Ctrl+C to stop.");
  console.log("");

  // An incident is printed once, whether it closed on its own or at shutdown.
  const printed = new Set();

  const recorder = createRecorder({
    target,
    contract,
    intervalMs,
    windowMs,
    // A simulated incident never embeds a real measurement: mixing genuine
    // evidence into a fabricated record is exactly what must not happen.
    deepCapture: simulation || args.flags["no-deep-capture"] ? null : createDeepCapture(),
    sampler: simulation ? createSimulationSampler(simulation) : undefined,
    simulation,
    captureOnStateChange: args.flags["capture-state-changes"] === true,
    onEvent: event => {
      if (event.type === "sample") console.log(renderSample(event.sample));
      else if (event.type === "trigger") console.log(`         ▲ ${event.trigger.summary}`);
      else if (event.type === "incident-open") console.log(`         ● incident ${event.id} opened`);
      else if (event.type === "deep-capture-start") console.log("         ● deep capture running");
      else if (event.type === "incident-recovered") console.log("         ● recovered");
      else if (event.type === "incident-closed") {
        const incident = recorder.getIncident(event.id);
        if (incident && !printed.has(incident.id)) {
          printed.add(incident.id);
          console.log(renderIncident(incident));
        }
      }
    }
  });

  const shutdown = () => {
    recorder.stop();
    const incident = recorder.latestIncident();
    if (incident && !printed.has(incident.id) && !process.env.FAULTLINE_RECORDER_QUIET) {
      // An incident still open at Ctrl+C is preserved and printed rather than
      // discarded, which is the whole point of a recorder.
      printed.add(incident.id);
      console.log(renderIncident(incident));
    }
    console.log("");
    console.log("Recording stopped. The rolling buffer is discarded; any closed incident was kept.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  recorder.start();

  if (simulation && !args.flags.duration) {
    // Run the scenario through to its end, plus a little for the incident to
    // close, so the demo completes without needing a stop signal.
    setTimeout(shutdown, simulation.totalMs + 20_000);
  }

  if (args.flags.duration) {
    const ms = Number(args.flags.duration) * 1000;
    if (Number.isFinite(ms) && ms > 0) setTimeout(shutdown, ms);
  }
}

main().catch(error => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

export { parseArgs, renderIncident, renderSample, RECORDER_STATE };
