#!/usr/bin/env node
import { collectRemoteProbe } from "./network.mjs";

function help() {
  console.log(`Faultline Remote Probe v0.3\n\nUsage:\n  npm run probe -- --run <run-id> [options]\n\nOptions:\n  --run <id>               Existing Faultline live run ID (required)\n  --api-base <url>         Faultline server base URL\n                           (default: http://localhost:3000)\n  --name <value>           Friendly name for this probe\n  --dry-run                Collect and print telemetry without uploading\n  --json                   Print the full JSON payload\n  --help                   Show this help\n\nExample:\n  npm run probe -- --run LIVE-ME5X2F --api-base http://192.168.1.20:3000 --name london-probe\n`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (["--run", "--api-base", "--name"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--run") options.runId = value;
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--name") options.name = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function getRun(base, runId) {
  const response = await fetch(`${base}/api/agent-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  return body;
}

async function upload(base, payload) {
  const response = await fetch(`${base}/api/probe-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  return body;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    help();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    help();
    return;
  }

  if (!options.runId) {
    console.error("Error: --run is required.\n");
    help();
    process.exitCode = 1;
    return;
  }

  const base = options.apiBase || "http://localhost:3000";

  try {
    const run = await getRun(base, options.runId);
    const target = run.telemetry?.target || {
      input: run.target,
      host: run.target,
      port: 443,
      url: /^https?:\/\//i.test(run.target) ? run.target : null
    };

    console.log(`Faultline: probing ${target.input || target.host} for run ${run.id}...`);
    const payload = await collectRemoteProbe({
      runId: run.id,
      target: target.input || target.host,
      port: target.port,
      name: options.name
    });

    const m = payload.metrics;
    console.log(`  DNS: ${m.dnsResolved ? "resolved" : "failed"} · ${m.dnsLookupMs} ms`);
    console.log(`  Target TCP: ${m.targetReachable ? "reachable" : "unreachable"} · ${m.targetTcpMs} ms`);
    if (m.targetHttpMs != null) console.log(`  Target HTTP: ${m.targetHttpMs} ms`);

    if (options.json || options.dryRun) console.log(JSON.stringify(payload, null, 2));

    if (options.dryRun) {
      console.log("Dry run complete. Nothing was uploaded.");
      return;
    }

    const correlated = await upload(base, payload);
    console.log(`\nCorrelated diagnosis: ${correlated.diagnosis.faultDomainLabel} (${correlated.diagnosis.confidence}% confidence)`);
    console.log(correlated.diagnosis.summary);
    console.log(`Run ${correlated.id} now has ${correlated.vantages.remoteProbe ? "two" : "one"} vantage point(s).`);
  } catch (error) {
    console.error(`Faultline remote probe failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
