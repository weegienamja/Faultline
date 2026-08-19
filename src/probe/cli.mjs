#!/usr/bin/env node
import { hostname, platform } from "node:os";
import { collectRemoteProbe } from "./network.mjs";

function help() {
  console.log(`Faultline Remote Probe v1.1\n\nRegistered worker:\n  npm run probe -- --probe <probe-id> --token <probe-token> [--watch]\n\nOne-off session probe:\n  npm run probe -- --session <session-id> --token <session-probe-token>\n\nOptions:\n  --probe <id>              Registered probe ID\n  --session <id>            Legacy one-off diagnostic session ID\n  --token <value>           Probe credential (or FAULTLINE_PROBE_TOKEN)\n  --api-base <url>          Faultline control-plane base URL\n                            (default: http://localhost:3000)\n  --name <value>            Friendly name used by one-off probes\n  --watch                   Keep registered probe online and poll for jobs\n  --interval <seconds>      Worker poll interval, 15-300 seconds (default: 30)\n  --dry-run                 Collect and print telemetry without uploading\n  --json                    Print full payloads\n  --help                    Show this help\n\nRegistered probe scope is controlled by the server. Public probes enforce public-target safety on every DNS resolution, TCP connection and HTTP redirect.\n`);
}

function parseInterval(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 15 || parsed > 300) {
    throw new Error("--interval must be an integer between 15 and 300 seconds.");
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { interval: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--watch") options.watch = true;
    else if (["--probe", "--session", "--token", "--api-base", "--name", "--interval"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--probe") options.probeId = value;
      if (arg === "--session") options.sessionId = value;
      if (arg === "--token") options.token = value;
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--name") options.name = value;
      if (arg === "--interval") options.interval = parseInterval(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function api(base, path, token, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Faultline API returned HTTP ${response.status}.`);
  return payload;
}

function runtime() {
  return {
    version: "1.1-preview",
    platform: platform(),
    hostname: hostname(),
    node: process.version
  };
}

async function collectJob(base, token, probe, job, options) {
  console.log(`Faultline: ${probe.name} probing ${job.target.input} for session ${job.id}...`);
  const payload = await collectRemoteProbe({
    sessionId: job.id,
    target: job.target.input,
    port: job.target.port,
    name: probe.name,
    scope: probe.scope || "public"
  });
  payload.probeId = probe.id;
  payload.probe = { runtime: runtime(), scope: probe.scope || "public" };

  const m = payload.metrics;
  console.log(`  DNS: ${m.dnsResolved ? "resolved" : "failed"} · ${m.dnsLookupMs} ms`);
  console.log(`  Target TCP: ${m.targetReachable ? "reachable" : "unreachable"} · ${m.targetTcpMs} ms`);
  if (m.targetHttpMs != null) console.log(`  Target HTTP: ${m.targetHttpMs} ms`);
  if (options.json || options.dryRun) console.log(JSON.stringify(payload, null, 2));

  if (options.dryRun) return;

  const correlated = await api(base, "/api/probe-runs", token, { method: "POST", body: payload });
  console.log(`  Diagnosis: ${correlated.diagnosis.faultDomainLabel} (${correlated.diagnosis.confidence}% confidence)`);
}

async function registeredCycle(base, token, probeId, options) {
  await api(base, `/api/probes/${encodeURIComponent(probeId)}/heartbeat`, token, {
    method: "POST",
    body: { runtime: runtime() }
  });

  const queue = await api(base, `/api/probes/${encodeURIComponent(probeId)}/jobs`, token);
  if (!queue.jobs.length) {
    console.log(`[${new Date().toISOString()}] ${queue.probe.name}: ${queue.probe.health} · no pending jobs`);
    return queue.probe;
  }

  console.log(`[${new Date().toISOString()}] ${queue.probe.name}: ${queue.jobs.length} pending job(s)`);
  for (const job of queue.jobs) {
    try {
      await collectJob(base, token, queue.probe, job, options);
    } catch (error) {
      const prefix = error.code === "TARGET_POLICY" ? "blocked by target policy" : "failed";
      console.error(`  Session ${job.id} ${prefix}: ${error.message}`);
    }
  }
  return queue.probe;
}

async function runRegistered(options, base, token) {
  const probe = await api(base, `/api/probes/${encodeURIComponent(options.probeId)}`, token);
  console.log(`Faultline registered probe: ${probe.name} (${probe.id})`);
  if (probe.location) console.log(`Location: ${probe.location}`);
  console.log(`Scope: ${probe.scope || "public"}`);

  do {
    await registeredCycle(base, token, probe.id, options);
    if (!options.watch) break;
    await new Promise(resolve => setTimeout(resolve, options.interval * 1000));
  } while (true);
}

async function runOneOff(options, base, token) {
  const session = await api(base, `/api/sessions/${encodeURIComponent(options.sessionId)}`, token);
  console.log(`Faultline: probing ${session.target.input} for session ${session.id}...`);

  const payload = await collectRemoteProbe({
    sessionId: session.id,
    target: session.target.input,
    port: session.target.port,
    name: options.name,
    scope: "private"
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

  const correlated = await api(base, "/api/probe-runs", token, { method: "POST", body: payload });
  console.log(`\nCorrelated diagnosis: ${correlated.diagnosis.faultDomainLabel} (${correlated.diagnosis.confidence}% confidence)`);
  console.log(correlated.diagnosis.summary);
  console.log(`Session ${correlated.id} now has two vantage points.`);
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
  if (Boolean(options.probeId) === Boolean(options.sessionId)) {
    throw new Error("Provide exactly one of --probe or --session.");
  }

  const token = options.token || process.env.FAULTLINE_PROBE_TOKEN;
  if (!token) throw new Error("Provide --token or set FAULTLINE_PROBE_TOKEN.");
  const base = options.apiBase || "http://localhost:3000";

  if (options.probeId) return runRegistered(options, base, token);
  return runOneOff(options, base, token);
}

main().catch(error => {
  console.error(`Faultline remote probe failed: ${error.message}`);
  process.exitCode = 1;
});
