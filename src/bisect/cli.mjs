#!/usr/bin/env node
// Faultline Network Bisect - command line entry point.
//
// Runs entirely locally. No server, no account, no API key, no external
// service. Every line of output is a real connection attempt from this machine.
//
// Default mode is ADAPTIVE: the engine forms competing explanations and picks
// the experiment that best separates them, stopping when the evidence has
// isolated a boundary. --all runs the complete condition matrix instead.

import { isolate } from "./adaptive.mjs";
import { bisect } from "./engine.mjs";
import { RESULT, STOP } from "./results.mjs";
import { ROUTE } from "./interfaces.mjs";
import { writeFile } from "node:fs/promises";

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: s => COLOUR ? `[2m${s}[0m` : s,
  bold: s => COLOUR ? `[1m${s}[0m` : s,
  green: s => COLOUR ? `[32m${s}[0m` : s,
  red: s => COLOUR ? `[31m${s}[0m` : s,
  yellow: s => COLOUR ? `[33m${s}[0m` : s,
  cyan: s => COLOUR ? `[36m${s}[0m` : s
};

function help() {
  console.log(`Faultline Network Bisect

Isolates which network condition changes whether a target works. Instead of
sweeping every test, it forms competing explanations, runs the experiment that
best separates them, and stops when the evidence has isolated a boundary.

Nothing on this machine is reconfigured: address family, DNS resolver, resolved
address, source interface, TLS version, ALPN, SNI and port are all varied per
connection.

Usage:
  npm run bisect -- <target> [options]

Targets:
  example.com          1.1.1.1
  https://example.com  https://example.com/health

Options:
  --all              Run the complete condition matrix instead of adaptive
                     planning (full capability audit)
  --repeat <n>       Trials per condition, 1-10 (default: 3)
  --confirm <n>      Interleaved A/B pairs used to confirm a difference (default: 3)
  --timeout <ms>     Per-connection timeout (default: 5000)
  --max <n>          Maximum experiments in adaptive mode (default: 12)
  --no-source        Skip the source-interface axis
  --resolvers <csv>  Comparison resolvers (default: 1.1.1.1,8.8.8.8,9.9.9.9)
  --json             Print the full machine-readable report
  --out <file>       Write the JSON report to a file
  --help             Show this help

Exit codes:
  0  no fault reproduced / target property / no meaningful difference
  1  a condition was isolated
  2  failure was not specific to any tested condition
  3  evidence insufficient (intermittent baseline, or unconfirmed)
  4  the run could not be performed

Examples:
  npm run bisect -- github.com
  npm run bisect -- github.com --all
  npm run bisect -- https://internal.example/health --repeat 5
`);
}

function parseArgs(argv) {
  const options = { repeat: 3, confirm: 3, timeout: 5000, includeSource: true, max: 12, mode: "adaptive" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--all" || arg === "--exhaustive") { options.mode = "exhaustive"; continue; }
    if (arg === "--no-source") { options.includeSource = false; continue; }
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      const int = (label, min, max) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
        return n;
      };
      if (arg === "--repeat") options.repeat = int("--repeat", 1, 10);
      else if (arg === "--confirm") options.confirm = int("--confirm", 1, 10);
      else if (arg === "--max") options.max = int("--max", 1, 40);
      else if (arg === "--timeout") {
        options.timeout = Number(value);
        if (!Number.isFinite(options.timeout) || options.timeout < 500 || options.timeout > 30000) throw new Error("--timeout must be between 500 and 30000 ms.");
      } else if (arg === "--resolvers") options.resolvers = value.split(",").map(s => s.trim()).filter(Boolean);
      else if (arg === "--out") options.out = value;
      else throw new Error(`Unknown option: ${arg}`);
      continue;
    }
    if (options.target) throw new Error("Provide exactly one target.");
    options.target = arg;
  }
  return options;
}

function resultCell(result) {
  if (result === RESULT.PASS) return c.green("PASS");
  if (result === RESULT.FAIL) return c.red("FAIL");
  if (result === RESULT.UNSTABLE) return c.yellow("UNSTABLE");
  if (result === RESULT.INAPPLICABLE) return c.dim("INAPPLICABLE");
  if (result === RESULT.UNSUPPORTED) return c.dim("UNSUPPORTED");
  return c.dim(String(result));
}

function wrap(text, width, indent = "  ") {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) { lines.push(indent + line.trim()); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(indent + line.trim());
  return lines;
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

// ---------------------------------------------------------------------------
// Adaptive presentation
// ---------------------------------------------------------------------------

function printInterfaces(report) {
  const list = report.interfaces || [];
  if (list.length < 2) return;
  console.log("");
  console.log(c.dim("  Local interfaces"));
  for (const i of list) {
    const note = i.routeSupport === ROUTE.NO_ROUTE ? c.dim("  NO TARGET ROUTE") : "";
    console.log(`    ${pad(i.name, 16)}${pad(i.address, 16)}${c.dim(pad(i.classification, 12))}${note}`);
  }
}

function printAdaptive(report) {
  const b = report.baseline;
  console.log("");
  console.log(`  ${c.bold("Baseline")}`);
  console.log(`  ${resultCell(b.result)} ${b.passes}/${b.total}${b.reason ? c.dim(` — ${b.reason}`) : ""}`);
  console.log("");
  if (b.state === "HEALTHY_BASELINE") {
    console.log(c.dim("  Normal connectivity is healthy. Running differential capability analysis."));
  } else if (b.state === "FAILED_BASELINE") {
    console.log(c.dim("  Baseline fails consistently. Isolating which condition changes that."));
  }

  let n = 0;
  for (const step of report.transcript) {
    if (step.kind === "experiment") {
      n += 1;
      console.log("");
      console.log(`  ${c.bold(`[${n}]`)} ${step.action}`);
      for (const line of wrap(step.why, 92, "      ")) console.log(c.dim(line));
      console.log(`      ${resultCell(step.result)} ${c.dim(step.detail || "")}`);
    }
    if (step.kind === "confirmation") {
      console.log("");
      console.log(`  ${c.bold("Confirming")} ${c.dim("(interleaved A/B; A = baseline)")}`);
      console.log(`      ${step.detail}   ${step.result === "CONFIRMED" ? c.green("held under alternation") : c.yellow("did not hold")}`);
    }
  }

  // Skipped experiments, grouped by why. This is the adaptive behaviour made visible.
  const skipped = report.skipped || [];
  if (skipped.length) {
    console.log("");
    const byReason = new Map();
    for (const s of skipped) {
      if (!byReason.has(s.skip)) byReason.set(s.skip, []);
      byReason.get(s.skip).push(s);
    }
    for (const [reason, items] of byReason) {
      const label = {
        "no-discrimination": "skipped: no live explanation disagrees about them",
        "axis-resolved": "skipped: this axis is already resolved",
        "inapplicable": "inapplicable on this machine",
        "expected-difference-only": "skipped: differs by design, not a fault (use --all)",
        "equivalent-already-run": "skipped: equivalent experiment already run",
        "budget-exhausted": "skipped: connection budget reached"
      }[reason] || reason;
      console.log(c.dim(`  ${items.length} ${label}`));
      for (const item of items.slice(0, 3)) console.log(c.dim(`      ${item.axisLabel}: ${item.label}`));
      if (items.length > 3) console.log(c.dim(`      … and ${items.length - 3} more`));
    }
  }
}

function printVerdict(report) {
  const v = report.verdict;
  const banner = {
    FAILURE_DISCRIMINATOR: c.green("FAILURE CONDITION ISOLATED"),
    WORKAROUND_CANDIDATE: c.green("WORKAROUND IDENTIFIED"),
    LOCAL_CAPABILITY_DEFICIENCY: c.yellow("CAPABILITY DIFFERENCE"),
    TARGET_PROPERTY: c.cyan("TARGET PROPERTY"),
    NO_MEANINGFUL_DIFFERENCE: c.dim("NO MEANINGFUL DIFFERENCE"),
    UNSTABLE_BASELINE: c.yellow("UNSTABLE BASELINE"),
    INAPPLICABLE_CONDITION: c.dim("NOT APPLICABLE"),
    INSUFFICIENT_EVIDENCE: c.yellow("INSUFFICIENT EVIDENCE")
  }[v.classification] || v.classification;

  console.log("");
  console.log(`  ${banner}`);
  console.log(`  ${c.bold(v.headline)}`);
  console.log("");
  for (const line of wrap(v.detail, 94)) console.log(line);
  if (v.claim) { console.log(""); for (const line of wrap(v.claim, 94)) console.log(c.cyan(line)); }
  if (v.workaround) { console.log(""); for (const line of wrap(v.workaround, 94)) console.log(c.dim(line)); }
  if (v.recommendation) { console.log(""); for (const line of wrap(v.recommendation, 94)) console.log(c.dim(line)); }

  const k = report.counters;
  console.log("");
  console.log(c.dim(`  Experiments: ${k.executed} executed, ${k.skipped} skipped as low-value, ${k.inapplicable} inapplicable.`));
  console.log(c.dim(`  ${k.connections} real connection attempts. Stopping reason: ${v.stop}.`));
  console.log(c.dim("  Association, not proof of cause."));
  if (report.mode === "adaptive") console.log(c.dim("  Run with --all for the complete condition matrix."));
}

// ---------------------------------------------------------------------------
// Exhaustive presentation, retained as a full capability audit
// ---------------------------------------------------------------------------

function printExhaustive(report) {
  console.log("");
  console.log(c.bold(`  ${pad("CONDITION", 30)}${pad("VARIANT", 34)}${pad("RESULT", 7)}${pad("n", 6)}DETAIL`));
  console.log(c.dim("  " + "-".repeat(100)));
  for (const row of report.conditions) {
    const isBaseline = row.axisId === "__baseline__";
    const name = isBaseline ? c.bold("baseline") : row.axisLabel;
    const cell = { pass: c.green("PASS  "), fail: c.red("FAIL  "), flaky: c.yellow("FLAKY "), inapplicable: c.dim("n/a   ") }[row.outcome] || row.outcome;
    console.log(`  ${pad(name, 30)}${pad(row.label, 34)}${cell}${pad(`${row.passes}/${row.total}`, 6)}${c.dim(`${row.stage ? `${row.stage}: ` : ""}${row.reason || ""}`)}`);
  }
  const v = report.verdict;
  console.log("");
  console.log(`  ${c.bold(v.headline)}`);
  console.log("");
  for (const line of wrap(v.detail, 94)) console.log(line);
  if (v.claim) { console.log(""); for (const line of wrap(v.claim, 94)) console.log(c.cyan(line)); }
  console.log("");
  console.log(c.dim(`  ${report.trialCount} real connection attempts (full condition matrix).`));
}

// ---------------------------------------------------------------------------

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`Error: ${error.message}\n`); help(); process.exitCode = 4; return; }

  if (options.help) return help();
  if (!options.target) { console.error("Error: a target is required.\n"); help(); process.exitCode = 4; return; }

  console.log("");
  console.log(c.bold(`  Faultline Network Bisect  ->  ${options.target}`));
  console.log(c.dim(`  ${options.mode === "adaptive" ? "Adaptive experiment planning" : "Exhaustive condition matrix"} · ${options.repeat} trials per condition · ${options.timeout}ms timeout`));

  let report;
  if (options.mode === "exhaustive") {
    report = await bisect(options.target, {
      repeat: options.repeat, confirmPairs: options.confirm, timeoutMs: options.timeout,
      includeSourceInterface: options.includeSource,
      ...(options.resolvers ? { resolvers: options.resolvers } : {}),
      onProgress: p => {
        if (options.json) return;
        if (p.phase === "baseline") process.stdout.write(c.dim("\n  measuring baseline ..."));
        if (p.phase === "baseline-done") process.stdout.write(c.dim(` ${p.outcome} (${p.passes}/${p.total})\n`));
        if (p.phase === "sweep-done") process.stdout.write(c.dim("."));
        if (p.phase === "confirm-done") process.stdout.write(c.dim(p.confirmed ? " confirmed\n" : " not confirmed\n"));
      }
    });
  } else {
    report = await isolate(options.target, {
      repeat: options.repeat, confirmPairs: options.confirm, timeoutMs: options.timeout,
      maxExperiments: options.max,
      ...(options.resolvers ? { resolvers: options.resolvers } : {})
    });
  }

  if (options.out) await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.mode === "exhaustive") {
    printExhaustive(report);
  } else {
    printInterfaces(report);
    printAdaptive(report);
    printVerdict(report);
    if (options.out) console.log(c.dim(`  JSON report written to ${options.out}`));
  }
  console.log("");

  const stop = report.verdict?.stop || report.verdict?.kind;
  process.exitCode = {
    [STOP.ISOLATED]: 1,
    [STOP.NO_DISCRIMINATOR]: 2,
    [STOP.TARGET_PROPERTY]: 0,
    [STOP.UNSTABLE]: 3,
    [STOP.INSUFFICIENT_EVIDENCE]: 3,
    [STOP.UNSUPPORTED]: 4,
    // exhaustive-mode verdict kinds
    isolated: 1, unconditional: 2, "not-published": 0, healthy: 0, intermittent: 3, unstable: 3
  }[stop] ?? 0;
}

main().catch(error => {
  console.error(`Faultline bisect failed: ${error.message}`);
  process.exitCode = 4;
});
