#!/usr/bin/env node
import { collectWindowsDiagnostics } from "./network.mjs";

function help() {
  console.log(`Faultline Agent v0.6 topology preview\n\nAuthenticated session mode:\n  npm run agent -- --session <session-id> --token <endpoint-token> [options]\n\nStandalone collection mode:\n  npm run agent -- --target <hostname|IP|URL> --dry-run [options]\n\nOptions:\n  --session <id>            Diagnostic session ID\n  --token <value>           Endpoint session credential (or FAULTLINE_ENDPOINT_TOKEN)\n  --api-base <url>          Faultline control-plane base URL\n                           (default: http://localhost:3000)\n  --target <value>          Standalone target when no session is used\n  --port <number>           Standalone target TCP port (default: 443)\n  --expected-route <CIDR>   Standalone expected IPv4 route\n  --vpn-required            Standalone target requires a VPN\n  --no-trace                Skip traceroute collection\n  --no-topology             Do not include passive local topology evidence\n  --dry-run                 Collect and print telemetry without uploading\n  --json                    Print the full JSON payload\n  --help                    Show this help\n\nTopology discovery is passive in this build. It reads the endpoint's existing Windows neighbour table and Wi-Fi association state; it does not sweep the subnet.\n`);
}

function parseArgs(argv) {
  const options = { trace: true, topology: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--vpn-required") options.vpnRequired = true;
    else if (arg === "--no-trace") options.trace = false;
    else if (arg === "--no-topology") options.topology = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (["--session", "--token", "--api-base", "--target", "--port", "--expected-route"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--session") options.sessionId = value;
      if (arg === "--token") options.token = value;
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--target") options.target = value;
      if (arg === "--port") options.port = Number(value);
      if (arg === "--expected-route") options.expectedRoute = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function fetchSession(base, sessionId, token) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  return body;
}

async function upload(base, token, payload) {
  const response = await fetch(`${base}/api/agent-runs`, {
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

  const base = options.apiBase || "http://localhost:3000";
  const token = options.token || process.env.FAULTLINE_ENDPOINT_TOKEN;
  let session = null;

  if (options.sessionId) {
    if (!token) throw new Error("Session mode requires --token or FAULTLINE_ENDPOINT_TOKEN.");
    session = await fetchSession(base, options.sessionId, token);
    options.target = session.target.input;
    options.port = session.target.port;
    options.vpnRequired = session.vpnRequired;
    options.expectedRoute = session.expectedRoute;
  } else if (!options.target) {
    console.error("Error: use --session for authenticated ingestion, or --target with --dry-run.\n");
    help();
    process.exitCode = 1;
    return;
  } else if (!options.dryRun) {
    throw new Error("Uploading endpoint evidence requires an authenticated session. Use npm run session first, or add --dry-run.");
  }

  console.log(`Faultline: collecting endpoint evidence for ${options.target}...`);
  const payload = await collectWindowsDiagnostics(options);
  if (session) payload.sessionId = session.id;
  const m = payload.metrics;
  const topology = payload.telemetry?.topology;

  console.log(`  Gateway: ${m.gatewayLatencyMs} ms · ${m.gatewayLoss}% loss`);
  console.log(`  DNS: ${m.dnsResolved ? "resolved" : "failed"} · ${m.dnsLookupMs} ms`);
  if (m.wifiSignalPct != null) console.log(`  Wi-Fi signal: ${m.wifiSignalPct}%`);
  console.log(`  Internet: ${m.internetReachable ? "reachable" : "unreachable"}`);
  console.log(`  Target TCP: ${m.targetReachable ? "reachable" : "unreachable"} · ${m.targetTcpMs} ms`);
  console.log(`  Target ICMP loss: ${m.upstreamLoss}% · jitter ${m.jitterMs} ms`);
  if (topology) {
    console.log(`  Topology: ${topology.kind} · ${topology.confidence} confidence · ${topology.nodes.length} nodes`);
  } else {
    console.log("  Topology: skipped");
  }

  if (options.json || options.dryRun) console.log(JSON.stringify(payload, null, 2));
  if (options.dryRun) {
    console.log("Dry run complete. Nothing was uploaded.");
    return;
  }

  const run = await upload(base, token, payload);
  console.log(`\nDiagnosis: ${run.diagnosis.faultDomainLabel} (${run.diagnosis.confidence}% confidence)`);
  console.log(run.diagnosis.summary);
  console.log(`Session ${run.id} now contains endpoint evidence.`);
  if (session?.assignedProbeId) {
    console.log(`Registered probe ${session.assignedProbeId} can now discover this session from its job queue.`);
  } else {
    console.log("Run the one-off remote-probe command issued when the diagnostic session was created to add the second vantage point.");
  }
}

main().catch(error => {
  console.error(`Faultline agent failed: ${error.message}`);
  process.exitCode = 1;
});
