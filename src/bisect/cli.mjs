#!/usr/bin/env node
// Faultline Network Bisect - command line entry point.
//
// Runs entirely locally. No server, no account, no API key, no external
// service. Every line of output is a real connection attempt from this machine.

import { bisect } from "./engine.mjs";
import { OUTCOME } from "./engine.mjs";
import { writeFile } from "node:fs/promises";

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: s => COLOUR ? `[2m${s}[0m` : s,
  bold: s => COLOUR ? `[1m${s}[0m` : s,
  green: s => COLOUR ? `[32m${s}[0m` : s,
  red: s => COLOUR ? `[31m${s}[0m` : s,
  yellow: s => COLOUR ? `[33m${s}[0m` : s,
  cyan: s => COLOUR ? `[36m${s}[0m` : s
};

function help() {
  console.log(`Faultline Network Bisect

Finds the smallest network condition that reproducibly changes whether a target
works, by varying one controlled condition at a time. Nothing on this machine is
reconfigured: address family, resolver, source interface, TLS version, ALPN and
SNI are all varied per connection.

Usage:
  npm run bisect -- <target> [options]

Targets:
  example.com
  1.1.1.1
  https://example.com
  https://example.com/health

Options:
  --repeat <n>       Trials per condition, 1-10 (default: 3). Higher is more
                     reliable against intermittent faults.
  --confirm <n>      Interleaved A/B pairs used to confirm the winner (default: 3)
  --timeout <ms>     Per-connection timeout in milliseconds (default: 5000)
  --no-source        Skip the source-interface axis
  --resolvers <csv>  Comparison resolvers (default: 1.1.1.1,8.8.8.8,9.9.9.9)
  --json             Print the full machine-readable report
  --out <file>       Write the JSON report to a file
  --help             Show this help

Examples:
  npm run bisect -- github.com
  npm run bisect -- https://internal.example/health --repeat 5
  npm run bisect -- example.com --json --out bisect.json
`);
}

function parseArgs(argv) {
  const options = { repeat: 3, confirm: 3, timeout: 5000, includeSource: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--no-source") { options.includeSource = false; continue; }
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--repeat") {
        options.repeat = Number(value);
        if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 10) throw new Error("--repeat must be an integer between 1 and 10.");
      } else if (arg === "--confirm") {
        options.confirm = Number(value);
        if (!Number.isInteger(options.confirm) || options.confirm < 1 || options.confirm > 10) throw new Error("--confirm must be an integer between 1 and 10.");
      } else if (arg === "--timeout") {
        options.timeout = Number(value);
        if (!Number.isFinite(options.timeout) || options.timeout < 500 || options.timeout > 30000) throw new Error("--timeout must be between 500 and 30000 ms.");
      } else if (arg === "--resolvers") {
        options.resolvers = value.split(",").map(s => s.trim()).filter(Boolean);
      } else if (arg === "--out") {
        options.out = value;
      } else {
        throw new Error(`Unknown option: ${arg}`);
      }
      continue;
    }
    if (options.target) throw new Error("Provide exactly one target.");
    options.target = arg;
  }
  return options;
}

function outcomeCell(outcome) {
  if (outcome === OUTCOME.PASS) return c.green("PASS  ");
  if (outcome === OUTCOME.FAIL) return c.red("FAIL  ");
  if (outcome === OUTCOME.FLAKY) return c.yellow("FLAKY ");
  return c.dim("n/a   ");
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function printTable(report) {
  console.log("");
  console.log(c.bold(`  ${pad("CONDITION", 30)}${pad("VARIANT", 34)}${pad("RESULT", 7)}${pad("n", 6)}DETAIL`));
  console.log(c.dim("  " + "-".repeat(100)));
  for (const row of report.conditions) {
    const isBaseline = row.axisId === "__baseline__";
    const name = isBaseline ? c.bold("baseline") : row.axisLabel;
    const detail = row.outcome === OUTCOME.INAPPLICABLE
      ? c.dim(row.reason || "not applicable")
      : c.dim(`${row.stage ? `${row.stage}: ` : ""}${row.reason || ""}`);
    console.log(`  ${pad(name, 30)}${pad(row.label, 34)}${outcomeCell(row.outcome)}${pad(`${row.passes}/${row.total}`, 6)}${detail}`);
  }
}

function printVerdict(report) {
  const v = report.verdict;
  console.log("");
  const banner = {
    isolated: c.green("CONDITION ISOLATED"),
    unconditional: c.yellow("NOT CONDITION-SPECIFIC"),
    intermittent: c.yellow("INTERMITTENT BASELINE"),
    unstable: c.yellow("UNCONFIRMED"),
    healthy: c.green("NO FAULT REPRODUCED"),
    "not-published": c.cyan("TARGET PROPERTY, NOT A LOCAL FAULT")
  }[v.kind] || v.kind.toUpperCase();

  console.log(`  ${banner}`);
  console.log(`  ${c.bold(v.headline)}`);
  console.log("");
  for (const line of wrap(v.detail, 96)) console.log(`  ${line}`);
  if (v.claim) {
    console.log("");
    for (const line of wrap(v.claim, 96)) console.log(`  ${c.cyan(line)}`);
  }
  if (v.recommendation) {
    console.log("");
    for (const line of wrap(v.recommendation, 96)) console.log(`  ${c.dim(line)}`);
  }
  if (v.alsoDiffering?.length) {
    console.log("");
    console.log(c.dim("  Other conditions that also differed:"));
    for (const item of v.alsoDiffering) console.log(c.dim(`    - ${item}`));
  }
  if (v.expectedDifferences?.length) {
    console.log("");
    console.log(c.dim("  Expected differences (normal behaviour, not a fault):"));
    for (const item of v.expectedDifferences) console.log(c.dim(`    - ${item}`));
  }
  if (report.confirmation) {
    const conf = report.confirmation;
    console.log("");
    const seq = conf.sequence.map(s => (s.arm === "baseline" ? "A" : "B") + (s.verdict === "pass" ? "+" : "-")).join(" ");
    console.log(c.dim(`  Interleaved confirmation (A=baseline, B=${conf.label}): ${seq}`));
    console.log(c.dim(`  ${conf.confirmed ? "Difference held under alternation." : "Difference did NOT hold under alternation."}`));
  }
  console.log("");
  console.log(c.dim(`  ${report.trialCount} real connection attempts. Association, not proof of cause.`));
}

function wrap(text, width) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    help();
    process.exitCode = 4;
    return;
  }

  if (options.help) return help();
  if (!options.target) {
    console.error("Error: a target is required.\n");
    help();
    process.exitCode = 4;
    return;
  }

  console.log("");
  console.log(c.bold(`  Faultline Network Bisect  ->  ${options.target}`));
  console.log(c.dim(`  ${options.repeat} trials per condition, ${options.confirm} confirmation pairs, ${options.timeout}ms timeout`));
  console.log(c.dim("  Varying one condition at a time. Nothing on this machine is reconfigured."));
  console.log("");

  let lastPhase = null;
  const report = await bisect(options.target, {
    repeat: options.repeat,
    confirmPairs: options.confirm,
    timeoutMs: options.timeout,
    includeSourceInterface: options.includeSource,
    ...(options.resolvers ? { resolvers: options.resolvers } : {}),
    onProgress: p => {
      if (options.json) return;
      if (p.phase === "baseline") process.stdout.write(c.dim("  measuring baseline ..."));
      if (p.phase === "baseline-done") process.stdout.write(c.dim(` ${p.outcome} (${p.passes}/${p.total})\n`));
      if (p.phase === "sweep" && lastPhase !== "sweep") { process.stdout.write(c.dim("  sweeping conditions ")); lastPhase = "sweep"; }
      if (p.phase === "sweep-done") process.stdout.write(c.dim("."));
      if (p.phase === "confirm") process.stdout.write(c.dim(`\n  confirming "${p.label}" with interleaved A/B `));
      if (p.phase === "confirm-done") process.stdout.write(c.dim(p.confirmed ? "confirmed\n" : "not confirmed\n"));
    }
  });

  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
    printVerdict(report);
    if (options.out) console.log(c.dim(`  JSON report written to ${options.out}\n`));
  }

  // Exit code carries the finding so the tool is usable in a script.
  //   0 no fault reproduced
  //   1 a differentiating condition was isolated
  //   2 failure was not condition specific
  //   3 evidence was insufficient (intermittent or unconfirmed)
//   4 the run could not be performed (bad usage or an internal failure)
  process.exitCode = { healthy: 0, isolated: 1, unconditional: 2, intermittent: 3, unstable: 3 }[report.verdict.kind] ?? 0;
}

main().catch(error => {
  console.error(`Faultline bisect failed: ${error.message}`);
  process.exitCode = 4;
});
