#!/usr/bin/env node
import { collectRemoteProbe } from "./network.mjs";

function help() {
  console.log(`Faultline Remote Probe v0.4\n\nUsage:\n  npm run probe -- --session <session-id> --token <probe-token> [options]\n\nOptions:\n  --session <id>            Diagnostic session ID (required)\n  --token <value>           Probe session credential (or FAULTLINE_PROBE_TOKEN)\n  --api-base <url>          Faultline control-plane base URL\n                           (default: http://localhost:3000)\n  --name <value>            Friendly name for this probe\n  --dry-run                 Collect and print telemetry without uploading\n  --json                    Print the full JSON payload\n  --help                    Show this help\n\nExample:\n  npm run probe -- --session FL-ABC123 --token <probe-token> --api-base https://faultline.example.com --name london-probe\n`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (["--session", "--token", "--api-base", "--name"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--session") options.sessionId = value;
      if (arg === "--token") options.token = value;
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--name") options.name = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function getSession(base, sessionId, token) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  return body;
}

async function upload(base, token, payload) {
  const response = await fetch(`${base}/api/probe-runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
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

  if (options.help) return help();
  if (!options.sessionId) {
    console.error("Error: --session is required.\n");
    help();
    process.exitCode = 1;
    return;
  }

  const token = options.token || process.env.FAULTLINE_PROBE_TOKEN;
  if (!token) throw new Error("Provide --token or set FAULTLINE_PROBE_TOKEN.");
  const base = options.apiBase || "http://localhost:3000";
  const session = await getSession(base, options.sessionId, token);

  console.log(`Faultline: probing ${session.target.input} for session ${session.id}...`);
  const payload = await collectRemoteProbe({
    sessionId: session.id,
    target: session.target.input,
    port: session.target.port,
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

  const correlated = await upload(base, token, payload);
  console.log(`\nCorrelated diagnosis: ${correlated.diagnosis.faultDomainLabel} (${correlated.diagnosis.confidence}% confidence)`);
  console.log(correlated.diagnosis.summary);
  console.log(`Session ${correlated.id} now has two vantage points.`);
}

main().catch(error => {
  console.error(`Faultline remote probe failed: ${error.message}`);
  process.exitCode = 1;
});
