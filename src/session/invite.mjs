#!/usr/bin/env node

function help() {
  console.log(`Faultline Invitation CLI v0.6 preview\n\nUsage:\n  npm run invite -- --target <hostname|IP|URL> [options]\n\nOptions:\n  --target <value>          Diagnostic target (required)\n  --port <number>           Target TCP port (default inferred from target)\n  --api-base <url>          Public Faultline base URL\n                            (default: http://localhost:3000)\n  --admin-token <token>     Admin bearer token (or FAULTLINE_ADMIN_TOKEN)\n  --probe <id>              Explicitly assign a registered probe\n  --one-off-probe           Do not auto-select a registered probe\n  --probe-country <value>   Auto-selection country label\n  --probe-region <value>    Auto-selection region label\n  --probe-tags <csv>        Required auto-selection tags\n  --probe-scope <value>     public or private (default: public)\n  --ttl <minutes>           Invitation/session lifetime, 5-1440 minutes\n  --title <value>           Incident title shown to the user\n  --customer <value>        Customer or support-case label\n  --vpn-required            Mark target as VPN-dependent\n  --expected-route <CIDR>   Expected IPv4 route for endpoint validation\n  --json                    Print the full creation response\n  --help                    Show this help\n\nBy default Faultline chooses the least-loaded matching online public probe.\n`);
}

function parseNumber(value, label, { min, max, integer = false }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { autoProbe: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--vpn-required") options.vpnRequired = true;
    else if (arg === "--one-off-probe") options.autoProbe = false;
    else if (arg === "--json") options.json = true;
    else if (["--target", "--port", "--api-base", "--admin-token", "--probe", "--probe-country", "--probe-region", "--probe-tags", "--probe-scope", "--ttl", "--title", "--customer", "--expected-route"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--target") options.target = value;
      if (arg === "--port") options.port = parseNumber(value, "--port", { min: 1, max: 65535, integer: true });
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--admin-token") options.adminToken = value;
      if (arg === "--probe") { options.assignedProbeId = value; options.autoProbe = false; }
      if (arg === "--probe-country") options.probeCountry = value;
      if (arg === "--probe-region") options.probeRegion = value;
      if (arg === "--probe-tags") options.probeTags = value.split(",");
      if (arg === "--probe-scope") options.probeScope = value;
      if (arg === "--ttl") options.ttlMinutes = parseNumber(value, "--ttl", { min: 5, max: 1440 });
      if (arg === "--title") options.title = value;
      if (arg === "--customer") options.customer = value;
      if (arg === "--expected-route") options.expectedRoute = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function validatePublicBase(value) {
  const parsed = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!local && parsed.protocol !== "https:") {
    throw new Error("Remote diagnostic invitation links must use HTTPS.");
  }
  return value.replace(/\/+$/, "");
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
  if (!options.target) {
    console.error("Error: --target is required.\n");
    help();
    process.exitCode = 1;
    return;
  }

  const adminToken = options.adminToken || process.env.FAULTLINE_ADMIN_TOKEN;
  if (!adminToken) {
    console.error("Error: provide --admin-token or set FAULTLINE_ADMIN_TOKEN.");
    process.exitCode = 1;
    return;
  }

  const base = validatePublicBase(options.apiBase || "http://localhost:3000");
  const probeSelector = options.autoProbe ? {
    scope: options.probeScope || "public",
    country: options.probeCountry,
    region: options.probeRegion,
    tags: options.probeTags
  } : undefined;

  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      target: options.target,
      port: options.port,
      ttlMinutes: options.ttlMinutes,
      title: options.title,
      customer: options.customer,
      vpnRequired: options.vpnRequired,
      expectedRoute: options.expectedRoute,
      assignedProbeId: options.assignedProbeId,
      probeSelector,
      ephemeral: true
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  if (!body.invitation?.path) throw new Error("Faultline did not return an invitation link.");

  const invitationUrl = `${base}${body.invitation.path}`;

  if (options.json) {
    console.log(JSON.stringify({ ...body, invitationUrl }, null, 2));
    return;
  }

  const { session, credentials } = body;
  console.log(`Faultline support diagnostic ${session.id} created.`);
  console.log(`Target: ${session.target.input}:${session.target.port}`);
  console.log(`Expires: ${session.expiresAt}`);
  if (session.assignedProbeId) {
    console.log(`Registered probe: ${session.assignedProbeId} (${session.probeSelection?.mode || "explicit"})`);
  }

  console.log("\nSend this one-time link to the affected user:");
  console.log(`  ${invitationUrl}`);
  console.log("\nThe invitation secret is carried in the URL fragment and is exchanged only after the user consents.");

  if (session.assignedProbeId) {
    console.log(`Registered probe ${session.assignedProbeId} will pick up the job after endpoint evidence arrives.`);
  } else if (credentials.probeToken) {
    console.log("\nRun the independent one-off probe from another network after the endpoint completes:");
    console.log(`  npm run probe -- --session ${session.id} --token ${credentials.probeToken} --api-base ${base}`);
  }
}

main().catch(error => {
  console.error(`Faultline invitation creation failed: ${error.message}`);
  process.exitCode = 1;
});
