import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { hostname, platform } from "node:os";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { buildTopology } from "../topology/infer.mjs";

const execFileAsync = promisify(execFile);

export function calculateJitter(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const deltas = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
  return deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
}

export function parsePingOutput(output, attempts = 6) {
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

export function parseTracerouteOutput(output) {
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
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export async function getWindowsNetworkState() {
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
} | ConvertTo-Json -Depth 6 -Compress
`;

  const state = await powershellJson(script) || {};
  return {
    defaultRoute: state.defaultRoute || null,
    adapter: state.adapter || null,
    address: state.address || null,
    vpnAdapters: asArray(state.vpnAdapters),
    routes: asArray(state.routes),
    neighbours: asArray(state.neighbors).map(item => ({
      ip: item.IPAddress,
      mac: item.LinkLayerAddress,
      state: item.State
    }))
  };
}

export async function getWifiState() {
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

export async function pingHost(target, attempts = 6) {
  const result = await runExecutable(
    "ping.exe",
    ["-n", String(attempts), "-w", "1200", target],
    { timeout: attempts * 1_500 + 2_000 }
  );
  return { ...parsePingOutput(result.stdout, attempts), rawAvailable: Boolean(result.stdout.trim()) };
}

export async function traceRoute(target, maxHops = 12) {
  const result = await runExecutable(
    "tracert.exe",
    ["-d", "-h", String(maxHops), "-w", "700", target],
    { timeout: maxHops * 2_400 + 4_000 }
  );
  return parseTracerouteOutput(result.stdout);
}

export async function resolveTarget(target) {
  const started = performance.now();
  try {
    const addresses = await lookup(target, { all: true });
    return {
      ok: addresses.length > 0,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      addresses: addresses.map(item => ({ address: item.address, family: item.family }))
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      addresses: [],
      error: error.code || error.message
    };
  }
}

export function tcpProbe(target, port, timeoutMs = 3_000) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host: target, port });
    let settled = false;

    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Number((performance.now() - started).toFixed(1));
      socket.destroy();
      resolve({ ok, elapsedMs, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, error.code || error.message));
  });
}

export async function httpProbe(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Faultline-Agent/1.5" }
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

export async function internetProbe() {
  const probes = await Promise.all([
    tcpProbe("1.1.1.1", 443, 2_500),
    tcpProbe("8.8.8.8", 53, 2_500)
  ]);
  return { ok: probes.some(probe => probe.ok), probes };
}

export function routeMatches(routes, expectedRoute) {
  if (!expectedRoute) return undefined;
  return routes.some(route => String(route.DestinationPrefix || "").toLowerCase() === expectedRoute.toLowerCase());
}

export function normaliseTarget(value, requestedPort) {
  const input = String(value || "").trim();
  if (!input) throw new Error("A target hostname, IP address or URL is required.");

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

function connectionLabel(adapter, wifi) {
  if (!adapter) return "Windows endpoint";
  const text = `${adapter.Name || ""} ${adapter.InterfaceDescription || ""} ${adapter.MediaType || ""}`;
  if (/wi-?fi|wireless|802\.11/i.test(text) || wifi.signalPct != null) return `Wi-Fi · ${adapter.Name || "adapter"}`;
  if (/ethernet|802\.3/i.test(text)) return `Ethernet · ${adapter.Name || "adapter"}`;
  return adapter.Name || adapter.InterfaceDescription || "Windows endpoint";
}

export async function collectWindowsDiagnostics(options) {
  if (platform() !== "win32") {
    throw new Error("Faultline Agent currently supports Windows only.");
  }

  const target = normaliseTarget(options.target, options.port);
  const networkState = await getWindowsNetworkState();
  const wifi = await getWifiState();
  const gateway = networkState.defaultRoute?.NextHop || null;
  const connection = connectionLabel(networkState.adapter, wifi);
  const topology = options.topology === false ? null : buildTopology({
    endpoint: {
      hostname: hostname(),
      ip: networkState.address?.IPAddress || null,
      mac: networkState.adapter?.MacAddress || null,
      connection
    },
    gateway: { ip: gateway },
    wifi,
    neighbours: networkState.neighbours
  });

  const [gatewayPing, dns, internet] = await Promise.all([
    gateway ? pingHost(gateway, 6) : Promise.resolve(null),
    resolveTarget(target.host),
    internetProbe()
  ]);

  const firstAddress = dns.addresses[0]?.address || null;
  const [targetPing, tcp, directIpPing, http, pathTrace] = await Promise.all([
    pingHost(target.host, 6),
    tcpProbe(target.host, target.port),
    firstAddress ? pingHost(firstAddress, 3) : Promise.resolve(null),
    target.url ? httpProbe(target.url) : Promise.resolve(null),
    options.trace === false ? Promise.resolve([]) : traceRoute(target.host)
  ]);

  const targetReachable = Boolean(tcp.ok || http?.ok);
  const icmpLikelyFiltered = targetPing.lossPct === 100 && targetReachable;
  const upstreamLoss = icmpLikelyFiltered ? 0 : targetPing.lossPct;
  const expectedRoutePresent = routeMatches(networkState.routes, options.expectedRoute);
  const vpnRequired = Boolean(options.vpnRequired || options.expectedRoute);

  const metrics = {
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
    upstreamLoss,
    jitterMs: icmpLikelyFiltered ? 0 : targetPing.jitterMs,
    targetReachable,
    targetTcpMs: tcp.elapsedMs,
    targetHttpMs: http?.elapsedMs ?? null
  };

  return {
    agent: {
      name: "faultline-windows",
      version: "1.5-preview",
      platform: "win32",
      hostname: hostname()
    },
    incident: {
      id: `LIVE-${Date.now().toString(36).toUpperCase()}`,
      title: `Live diagnostic · ${target.host}`,
      customer: "Live endpoint",
      target: target.input,
      location: `${hostname()} · Windows`,
      connection
    },
    metrics,
    telemetry: {
      collectedAt: new Date().toISOString(),
      target: {
        input: target.input,
        host: target.host,
        port: target.port,
        url: target.url
      },
      gateway,
      adapter: networkState.adapter ? {
        name: networkState.adapter.Name,
        description: networkState.adapter.InterfaceDescription,
        macAddress: networkState.adapter.MacAddress,
        linkSpeed: networkState.adapter.LinkSpeed,
        mediaType: networkState.adapter.MediaType,
        ipv4: networkState.address?.IPAddress || null,
        prefixLength: networkState.address?.PrefixLength ?? null
      } : null,
      wifi,
      topology,
      vpnAdapters: networkState.vpnAdapters.map(adapter => ({
        name: adapter.Name,
        description: adapter.InterfaceDescription,
        interfaceIndex: adapter.InterfaceIndex
      })),
      expectedRoute: options.expectedRoute || null,
      resolvedAddresses: dns.addresses,
      internetProbe: internet,
      targetProbe: {
        tcp,
        http,
        icmp: targetPing,
        icmpLikelyFiltered
      },
      pathTrace
    }
  };
}
