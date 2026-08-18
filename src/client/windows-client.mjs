import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { hostname, homedir, platform } from "node:os";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const CLIENT_VERSION = "0.6-client-preview";

function pauseOnInteractiveExit() {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\nPress Enter to close Faultline.\n");
  process.stdin.resume();
  process.stdin.once("data", () => process.exit());
}

function progress(label, state = "working") {
  const mark = state === "ok" ? "[OK]" : state === "fail" ? "[!!]" : "[..]";
  console.log(`${mark} ${label}`);
}

function normaliseMac(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

function macOui(value) {
  const mac = normaliseMac(value);
  return mac ? mac.split(":").slice(0, 3).join(":") : null;
}

function calculateJitter(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const deltas = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
  return deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
}

function parsePingOutput(output, attempts = 6) {
  const text = String(output || "");
  const samples = [...text.matchAll(/time[=<]\s*(\d+)\s*ms/gi)].map(match => Number(match[1]));
  const lossMatch = text.match(/\((\d+(?:\.\d+)?)%\s*loss\)/i);
  const inferredLoss = attempts > 0 ? ((attempts - Math.min(samples.length, attempts)) / attempts) * 100 : 100;
  const lossPct = lossMatch ? Number(lossMatch[1]) : inferredLoss;
  const averageMs = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
  return {
    attempts,
    replies: samples.length,
    lossPct: Number(lossPct.toFixed(1)),
    averageMs: Number(averageMs.toFixed(1)),
    minMs: samples.length ? Math.min(...samples) : 0,
    maxMs: samples.length ? Math.max(...samples) : 0,
    jitterMs: Number(calculateJitter(samples).toFixed(1)),
    samples
  };
}

function parseTracerouteOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map(line => {
      const hopMatch = line.match(/^\s*(\d+)\s+/);
      if (!hopMatch) return null;
      const ipMatch = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      const rtts = [...line.matchAll(/<?(\d+)\s*ms/gi)].map(match => Number(match[1]));
      return {
        hop: Number(hopMatch[1]),
        ip: ipMatch?.[1] || null,
        averageRttMs: rtts.length ? Number((rtts.reduce((sum, value) => sum + value, 0) / rtts.length).toFixed(1)) : null,
        timedOut: !ipMatch && line.includes("*")
      };
    })
    .filter(Boolean);
}

async function runExecutable(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: options.timeout ?? 12_000,
      maxBuffer: 1024 * 1024
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      exitCode: Number.isInteger(error.code) ? error.code : 1
    };
  }
}

async function powershellJson(script) {
  const result = await runExecutable(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 10_000 }
  );
  if (!result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function getWindowsNetworkState() {
  const script = `
$default = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
$adapter = if ($default) { Get-NetAdapter -InterfaceIndex $default.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1 Name, InterfaceDescription, Status, MacAddress, LinkSpeed, MediaType, InterfaceIndex }
$address = if ($default) { Get-NetIPAddress -InterfaceIndex $default.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 IPAddress, PrefixLength }
$vpn = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'VPN|Cisco|AnyConnect|Secure Client|WireGuard|TAP|TUN|GlobalProtect|Forti' -or $_.InterfaceDescription -match 'VPN|Cisco|AnyConnect|Secure Client|WireGuard|TAP|TUN|GlobalProtect|Forti') } | Select-Object Name, InterfaceDescription, Status, InterfaceIndex)
$routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 120 DestinationPrefix, NextHop, InterfaceAlias, RouteMetric, InterfaceMetric, InterfaceIndex)
$neighbors = if ($default) { @(Get-NetNeighbor -InterfaceIndex $default.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Unreachable' -and $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } | Select-Object -First 64 IPAddress, LinkLayerAddress, State) } else { @() }
[pscustomobject]@{
  defaultRoute = if ($default) { [pscustomobject]@{ NextHop=$default.NextHop; InterfaceAlias=$default.InterfaceAlias; RouteMetric=$default.RouteMetric; InterfaceMetric=$default.InterfaceMetric; InterfaceIndex=$default.InterfaceIndex } } else { $null }
  adapter = $adapter
  address = $address
  vpnAdapters = $vpn
  routes = $routes
  neighbors = $neighbors
} | ConvertTo-Json -Depth 6 -Compress`;

  const state = await powershellJson(script) || {};
  return {
    defaultRoute: state.defaultRoute || null,
    adapter: state.adapter || null,
    address: state.address || null,
    vpnAdapters: asArray(state.vpnAdapters),
    routes: asArray(state.routes),
    neighbours: asArray(state.neighbors).map(item => ({ ip: item.IPAddress, mac: item.LinkLayerAddress, state: item.State }))
  };
}

async function getWifiState() {
  const result = await runExecutable("netsh.exe", ["wlan", "show", "interfaces"], { timeout: 6_000 });
  const signal = result.stdout.match(/^\s*Signal\s*:\s*(\d+)%/mi);
  const ssid = result.stdout.match(/^\s*SSID\s*:\s*(.+)$/mi);
  const bssid = result.stdout.match(/^\s*BSSID\s*:\s*([0-9a-f:-]{17})/mi);
  const radio = result.stdout.match(/^\s*Radio type\s*:\s*(.+)$/mi);
  const channel = result.stdout.match(/^\s*Channel\s*:\s*(\d+)/mi);
  return {
    signalPct: signal ? Number(signal[1]) : null,
    ssid: ssid?.[1]?.trim() || null,
    bssid: bssid?.[1]?.trim() || null,
    radioType: radio?.[1]?.trim() || null,
    channel: channel ? Number(channel[1]) : null
  };
}

async function pingHost(target, attempts = 6) {
  const result = await runExecutable("ping.exe", ["-n", String(attempts), "-w", "1200", target], { timeout: attempts * 1_500 + 2_000 });
  return { ...parsePingOutput(result.stdout, attempts), rawAvailable: Boolean(result.stdout.trim()) };
}

async function traceRoute(target, maxHops = 12) {
  const result = await runExecutable("tracert.exe", ["-d", "-h", String(maxHops), "-w", "700", target], { timeout: maxHops * 2_400 + 4_000 });
  return parseTracerouteOutput(result.stdout);
}

async function resolveTarget(target) {
  const started = performance.now();
  try {
    const addresses = await lookup(target, { all: true });
    return { ok: addresses.length > 0, elapsedMs: Number((performance.now() - started).toFixed(1)), addresses };
  } catch (error) {
    return { ok: false, elapsedMs: Number((performance.now() - started).toFixed(1)), addresses: [], error: error.code || error.message };
  }
}

function tcpProbe(target, port, timeoutMs = 3_000) {
  return new Promise(resolveProbe => {
    const started = performance.now();
    const socket = net.createConnection({ host: target, port });
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Number((performance.now() - started).toFixed(1));
      socket.destroy();
      resolveProbe({ ok, elapsedMs, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, error.code || error.message));
  });
}

async function httpProbe(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": `Faultline-Windows/${CLIENT_VERSION}` }
    });
    const elapsedMs = Number((performance.now() - started).toFixed(1));
    await response.body?.cancel().catch(() => {});
    return { ok: response.status < 500, elapsedMs, status: response.status, finalUrl: response.url };
  } catch (error) {
    return { ok: false, elapsedMs: Number((performance.now() - started).toFixed(1)), error: error.name || error.message };
  } finally {
    clearTimeout(timer);
  }
}

function normaliseTarget(value, requestedPort) {
  const input = String(value || "").trim();
  if (!input) throw new Error("A diagnostic target is required.");
  let url = null;
  let host = input;
  let port = Number(requestedPort || 0) || null;
  if (/^https?:\/\//i.test(input)) {
    url = new URL(input);
    host = url.hostname;
    if (!port) port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  } else {
    host = input.replace(/^\[|\]$/g, "");
    if (!port) port = 443;
    if (!net.isIP(host)) url = new URL(`https://${host}`);
  }
  return { input, host, port, url: url?.toString() || null };
}

function routeMatches(routes, expectedRoute) {
  if (!expectedRoute) return undefined;
  return routes.some(route => String(route.DestinationPrefix || "").toLowerCase() === String(expectedRoute).toLowerCase());
}

function connectionLabel(adapter, wifi) {
  if (!adapter) return "Windows endpoint";
  const text = `${adapter.Name || ""} ${adapter.InterfaceDescription || ""} ${adapter.MediaType || ""}`;
  if (/wi-?fi|wireless|802\.11/i.test(text) || wifi.signalPct != null) return `Wi-Fi · ${adapter.Name || "adapter"}`;
  if (/ethernet|802\.3/i.test(text)) return `Ethernet · ${adapter.Name || "adapter"}`;
  return adapter.Name || adapter.InterfaceDescription || "Windows endpoint";
}

function buildTopology({ endpoint, gateway, wifi, neighbours }) {
  const nodes = [];
  const links = [];
  const endpointId = "endpoint";
  const gatewayId = gateway?.ip ? `gateway:${gateway.ip}` : null;
  const endpointMac = normaliseMac(endpoint.mac);
  const gatewayNeighbour = neighbours.find(item => item.ip === gateway?.ip) || null;
  const gatewayMac = normaliseMac(gatewayNeighbour?.mac);
  const bssid = normaliseMac(wifi?.bssid);

  nodes.push({
    id: endpointId,
    type: "endpoint",
    label: endpoint.hostname || "Windows endpoint",
    ip: endpoint.ip || null,
    mac: endpointMac,
    confidence: "high",
    observed: true
  });

  if (!gatewayId) {
    return {
      version: 1,
      kind: "unknown",
      confidence: "low",
      nodes,
      links,
      affectedPath: [endpointId],
      discovery: { mode: "passive", activeScan: false, source: "windows-client" }
    };
  }

  nodes.push({ id: gatewayId, type: "gateway", label: "Default gateway", ip: gateway.ip, mac: gatewayMac, confidence: "high", observed: true });
  let accessNodeId = gatewayId;
  let kind = "star";
  let confidence = "medium";

  if (bssid && gatewayMac && bssid !== gatewayMac) {
    const sameVendor = macOui(bssid) === macOui(gatewayMac);
    accessNodeId = `ap:${bssid}`;
    nodes.push({
      id: accessNodeId,
      type: sameVendor ? "mesh" : "access_point",
      label: sameVendor ? "Likely mesh / access point" : "Wireless access point",
      mac: bssid,
      confidence: sameVendor ? "low" : "medium",
      observed: true
    });
    links.push({ from: endpointId, to: accessNodeId, relation: "wifi", observed: true, confidence: "high" });
    links.push({ from: accessNodeId, to: gatewayId, relation: sameVendor ? "possible-mesh-backhaul" : "access-layer", observed: false, confidence: "low" });
    kind = sameVendor ? "mesh" : "tree";
    confidence = sameVendor ? "low" : "medium";
  } else {
    const observedWifi = Boolean(bssid && gatewayMac && bssid === gatewayMac);
    links.push({
      from: endpointId,
      to: gatewayId,
      relation: observedWifi ? "wifi" : "local-path",
      observed: observedWifi,
      confidence: observedWifi ? "high" : "medium"
    });
    confidence = observedWifi ? "high" : "medium";
  }

  for (const neighbour of neighbours.slice(0, 24)) {
    if (!neighbour.ip || neighbour.ip === gateway.ip || neighbour.ip === endpoint.ip) continue;
    const id = `lan:${neighbour.ip}`;
    nodes.push({ id, type: "unknown", label: neighbour.ip, ip: neighbour.ip, mac: normaliseMac(neighbour.mac), confidence: "medium", observed: true });
    links.push({ from: gatewayId, to: id, relation: "local-neighbour", observed: false, confidence: "low" });
  }

  const boundaryId = "internet";
  nodes.push({ id: boundaryId, type: "boundary", label: "Internet", confidence: "high", observed: false });
  links.push({ from: gatewayId, to: boundaryId, relation: "upstream", observed: false, confidence: "high" });

  return {
    version: 1,
    kind,
    confidence,
    nodes,
    links,
    affectedPath: [endpointId, accessNodeId, gatewayId, boundaryId].filter((value, index, values) => values.indexOf(value) === index),
    discovery: { mode: "passive", activeScan: false, source: "windows-client" }
  };
}

async function collectDiagnostics(session, includeTopology) {
  const target = normaliseTarget(session.target.input, session.target.port);
  progress("Reading Windows network state");
  const networkState = await getWindowsNetworkState();
  const wifi = await getWifiState();
  progress("Reading Windows network state", "ok");

  const gateway = networkState.defaultRoute?.NextHop || null;
  const connection = connectionLabel(networkState.adapter, wifi);
  const topology = includeTopology ? buildTopology({
    endpoint: {
      hostname: hostname(),
      ip: networkState.address?.IPAddress || null,
      mac: networkState.adapter?.MacAddress || null,
      connection
    },
    gateway: { ip: gateway },
    wifi,
    neighbours: networkState.neighbours
  }) : null;

  progress("Testing gateway, DNS and internet reachability");
  const [gatewayPing, dns, internetProbes] = await Promise.all([
    gateway ? pingHost(gateway, 6) : Promise.resolve(null),
    resolveTarget(target.host),
    Promise.all([tcpProbe("1.1.1.1", 443, 2_500), tcpProbe("8.8.8.8", 53, 2_500)])
  ]);
  const internet = { ok: internetProbes.some(probe => probe.ok), probes: internetProbes };
  progress("Testing gateway, DNS and internet reachability", "ok");

  progress(`Testing ${target.host}:${target.port}`);
  const firstAddress = dns.addresses[0]?.address || null;
  const [targetPing, tcp, directIpPing, http, pathTrace] = await Promise.all([
    pingHost(target.host, 6),
    tcpProbe(target.host, target.port),
    firstAddress ? pingHost(firstAddress, 3) : Promise.resolve(null),
    target.url ? httpProbe(target.url) : Promise.resolve(null),
    traceRoute(target.host)
  ]);
  progress(`Testing ${target.host}:${target.port}`, "ok");

  const targetReachable = Boolean(tcp.ok || http?.ok);
  const icmpLikelyFiltered = targetPing.lossPct === 100 && targetReachable;
  const expectedRoutePresent = routeMatches(networkState.routes, session.expectedRoute);
  const vpnRequired = Boolean(session.vpnRequired || session.expectedRoute);

  return {
    sessionId: session.id,
    agent: {
      name: "faultline-windows-client",
      version: CLIENT_VERSION,
      platform: "win32",
      hostname: hostname()
    },
    incident: {
      id: session.id,
      title: session.title,
      customer: session.customer,
      target: session.target.input,
      location: `${hostname()} · Windows`,
      connection
    },
    metrics: {
      gatewayLoss: gatewayPing?.lossPct ?? 0,
      gatewayLatencyMs: gatewayPing?.averageMs ?? 0,
      wifiSignalPct: wifi.signalPct,
      dnsResolved: dns.ok,
      dnsLookupMs: dns.elapsedMs,
      directIpReachable: directIpPing ? directIpPing.replies > 0 || tcp.ok : false,
      internetReachable: internet.ok,
      vpnRequired,
      vpnConnected: networkState.vpnAdapters.length > 0,
      expectedRoutePresent,
      upstreamLoss: icmpLikelyFiltered ? 0 : targetPing.lossPct,
      jitterMs: icmpLikelyFiltered ? 0 : targetPing.jitterMs,
      targetReachable,
      targetTcpMs: tcp.elapsedMs,
      targetHttpMs: http?.elapsedMs ?? null
    },
    telemetry: {
      collectedAt: new Date().toISOString(),
      target,
      gateway,
      networkState,
      wifi,
      topology,
      probes: {
        gatewayPing,
        dns,
        internet,
        targetPing,
        tcp,
        directIpPing,
        http,
        traceroute: pathTrace,
        icmpLikelyFiltered
      }
    }
  };
}

async function apiRequest(apiBase, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Faultline returned HTTP ${response.status}.`);
  return payload;
}

async function candidateHandoffFiles() {
  const roots = [...new Set([process.cwd(), dirname(process.execPath), join(homedir(), "Downloads")])];
  const candidates = [];
  for (const root of roots) {
    try {
      const names = await readdir(root);
      for (const name of names) {
        if (!/^Faultline-FL-[A-Z0-9-]+\.faultline$/i.test(name)) continue;
        const path = join(root, name);
        const info = await stat(path);
        candidates.push({ path, mtimeMs: info.mtimeMs });
      }
    } catch {}
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function loadHandoff() {
  const explicit = process.argv.slice(2).find(arg => !arg.startsWith("--"));
  const candidates = explicit ? [{ path: resolve(explicit), mtimeMs: Date.now() }] : await candidateHandoffFiles();
  if (!candidates.length) {
    throw new Error("No Faultline handoff file was found. Download the .faultline file from the support diagnostic page and run Faultline.exe again.");
  }
  const handoffPath = candidates[0].path;
  const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
  if (handoff.version !== 1 || !handoff.sessionId || !handoff.apiBase || !handoff.launchToken) {
    throw new Error("The Faultline handoff file is invalid.");
  }
  if (!/^https?:\/\//i.test(handoff.apiBase)) throw new Error("The Faultline control-plane address is invalid.");
  if (!/^FL-[A-Z0-9]+$/i.test(handoff.sessionId)) throw new Error("The Faultline session identifier is invalid.");
  if (!/^fl_launch_/i.test(handoff.launchToken)) throw new Error("The Faultline launch credential is invalid.");
  return { handoff, handoffPath };
}

async function retryUpload(apiBase, endpointToken, payload, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await apiRequest(apiBase, "/api/agent-runs", {
        method: "POST",
        token: endpointToken,
        body: payload
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 1_500));
    }
  }
  throw lastError;
}

async function selfTest() {
  const ping = parsePingOutput("Reply from 1.1.1.1: bytes=32 time=10ms TTL=56\nReply from 1.1.1.1: bytes=32 time=14ms TTL=56\nPackets: Sent = 2, Received = 2, Lost = 0 (0% loss)", 2);
  if (ping.lossPct !== 0 || ping.averageMs !== 12) throw new Error("Ping parser self-test failed.");
  const topology = buildTopology({
    endpoint: { hostname: "test", ip: "192.168.1.10", mac: "AA-BB-CC-00-00-10" },
    gateway: { ip: "192.168.1.1" },
    wifi: { bssid: "AA-BB-CC-00-00-01" },
    neighbours: [{ ip: "192.168.1.1", mac: "AA-BB-CC-00-00-01", state: "Reachable" }]
  });
  if (topology.kind !== "star") throw new Error("Topology self-test failed.");
  console.log(`Faultline Windows ${CLIENT_VERSION} self-test passed.`);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (platform() !== "win32") throw new Error("Faultline Windows Client can only run on Windows.");

  console.log("Faultline Diagnostic");
  console.log("====================");
  console.log("This one-time client collects network measurements only. It does not capture packet contents, files, passwords or browsing history.\n");

  const { handoff, handoffPath } = await loadHandoff();
  progress(`Opening diagnostic ${handoff.sessionId}`);
  const exchange = await apiRequest(handoff.apiBase.replace(/\/+$/, ""), "/api/client/exchange", {
    method: "POST",
    token: handoff.launchToken,
    body: { sessionId: handoff.sessionId }
  });
  const endpointToken = exchange.credentials?.endpointToken;
  if (!endpointToken) throw new Error("Faultline did not return an endpoint credential.");
  progress(`Opening diagnostic ${handoff.sessionId}`, "ok");
  await unlink(handoffPath).catch(() => {});

  const session = exchange.session;
  const includeTopology = exchange.client?.includeTopology !== false;
  const payload = await collectDiagnostics(session, includeTopology);

  progress("Uploading diagnostic evidence");
  try {
    const result = await retryUpload(handoff.apiBase.replace(/\/+$/, ""), endpointToken, payload);
    progress("Uploading diagnostic evidence", "ok");
    console.log(`\nDiagnostic complete. Reference: ${session.id}`);
    console.log(`Fault domain: ${result.diagnosis?.label || result.diagnosis?.faultDomain || "pending correlation"}`);
    console.log("You may now close this window. Your support engineer can view the submitted evidence.");
  } catch (error) {
    const recovery = join(dirname(handoffPath), `Faultline-${session.id}-results.json`);
    await writeFile(recovery, `${JSON.stringify(payload, null, 2)}\n`, "utf8").catch(() => {});
    throw new Error(`Evidence upload failed after retries: ${error.message}. A token-free recovery payload was saved to ${recovery}.`);
  }
}

main()
  .then(() => pauseOnInteractiveExit())
  .catch(error => {
    progress(error.message, "fail");
    pauseOnInteractiveExit();
    if (!process.stdin.isTTY) process.exitCode = 1;
  });
