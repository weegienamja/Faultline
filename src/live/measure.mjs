// Real local measurement engine for live diagnostics.
//
// Everything here is an OBSERVED measurement taken from the machine running the
// Faultline control plane. Where a measurement cannot be taken, the field is
// reported explicitly as "unknown", "not-measured" or "unsupported". Nothing is
// invented or defaulted to a plausible-looking number.

import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { hostname, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UNKNOWN = "unknown";
export const NOT_MEASURED = "not-measured";
export const UNSUPPORTED = "unsupported";

/** Public resolvers Faultline compares the system resolver against. */
export const COMPARISON_RESOLVERS = Object.freeze([
  { id: "cloudflare", label: "Cloudflare 1.1.1.1", address: "1.1.1.1" },
  { id: "google", label: "Google 8.8.8.8", address: "8.8.8.8" },
  { id: "quad9", label: "Quad9 9.9.9.9", address: "9.9.9.9" }
]);

function elapsedSince(started) {
  return Number((performance.now() - started).toFixed(1));
}

async function runExecutable(command, args, { timeout = 12_000 } = {}) {
  try {
    const result = await execFileAsync(command, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || error.message || "", failed: true };
  }
}

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

export function parseLiveTarget(value, requestedPort) {
  const input = String(value || "").trim();
  if (!input) throw new Error("A target hostname, IP address or URL is required.");
  if (input.length > 512) throw new Error("Target is too long.");
  if (input.includes("://") && !/^https?:\/\//i.test(input)) {
    throw new Error("Only HTTP and HTTPS URLs are supported as URL targets.");
  }

  let url = null;
  let host = input;
  let scheme = null;

  // Only an omitted port means "infer". An explicitly supplied invalid port is
  // rejected rather than silently defaulting to 443.
  let port = null;
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== "") {
    port = Number(requestedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Target port must be an integer between 1 and 65535.");
    }
  }

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    if (!parsed.hostname) throw new Error("Target URL has no hostname.");
    url = parsed.toString();
    // URL.hostname keeps the brackets on an IPv6 literal; strip them so the
    // address classifier sees a real IP rather than treating it as a hostname.
    host = parsed.hostname.replace(/^\[|\]$/g, "");
    scheme = parsed.protocol.replace(":", "");
    if (!port) port = Number(parsed.port || (scheme === "http" ? 80 : 443));
  } else {
    host = input.replace(/^\[|\]$/g, "");
    if (host.includes("/")) throw new Error("Target host must not contain a path. Use a full https:// URL instead.");
    if (!port) port = 443;
    scheme = port === 80 ? "http" : "https";
    if (!net.isIP(host)) url = `${scheme}://${host}${(port === 80 || port === 443) ? "" : `:${port}`}/`;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Target port must be an integer between 1 and 65535.");
  if (!net.isIP(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) {
    throw new Error("Target hostname is not a valid DNS name or IP address.");
  }

  return { input, host, port, url, scheme, isLiteralIp: Boolean(net.isIP(host)) };
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

async function resolveWith(resolver, host, kind) {
  const started = performance.now();
  try {
    const records = kind === "AAAA" ? await resolver.resolve6(host) : await resolver.resolve4(host);
    return { ok: true, elapsedMs: elapsedSince(started), addresses: records, error: null };
  } catch (error) {
    return { ok: false, elapsedMs: elapsedSince(started), addresses: [], error: error.code || error.message };
  }
}

/**
 * System resolver servers configured on this machine.
 * These are LOCAL configuration facts, never sent to third parties.
 */
export function systemResolvers() {
  try {
    const servers = dns.getServers();
    return Array.isArray(servers) && servers.length ? servers : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the target through the system resolver and a set of public
 * comparison resolvers, so a divergent resolver becomes visible evidence.
 */
export async function measureDns(host, { timeoutMs = 4_000, comparisons = COMPARISON_RESOLVERS } = {}) {
  if (net.isIP(host)) {
    return {
      measured: false,
      state: NOT_MEASURED,
      reason: "Target is a literal IP address, so no DNS resolution is required.",
      systemResolvers: systemResolvers(),
      system: null,
      comparisons: [],
      agreement: null
    };
  }

  const system = new Resolver({ timeout: timeoutMs, tries: 1 });
  const [a, aaaa, ns] = await Promise.all([
    resolveWith(system, host, "A"),
    resolveWith(system, host, "AAAA"),
    (async () => {
      const started = performance.now();
      try { return { ok: true, elapsedMs: elapsedSince(started), records: await system.resolveNs(host), error: null }; }
      catch (error) { return { ok: false, elapsedMs: elapsedSince(started), records: [], error: error.code || error.message }; }
    })()
  ]);

  const comparisonResults = await Promise.all(comparisons.map(async entry => {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    try { resolver.setServers([entry.address]); }
    catch { return { ...entry, ok: false, elapsedMs: null, addresses: [], error: "resolver-unavailable" }; }
    const result = await resolveWith(resolver, host, "A");
    return { id: entry.id, label: entry.label, address: entry.address, ...result };
  }));

  // Agreement is computed only across resolvers that actually answered.
  const answered = [
    ...(a.ok ? [{ id: "system", addresses: a.addresses }] : []),
    ...comparisonResults.filter(r => r.ok).map(r => ({ id: r.id, addresses: r.addresses }))
  ];
  const signatures = new Map();
  for (const entry of answered) {
    const signature = [...entry.addresses].sort().join(",");
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature).push(entry.id);
  }

  const agreement = answered.length < 2
    ? { state: NOT_MEASURED, reason: "Fewer than two resolvers answered, so no comparison is possible." }
    : signatures.size === 1
      ? { state: "consistent", distinctAnswers: 1, groups: [...signatures.entries()].map(([addresses, ids]) => ({ addresses: addresses.split(","), resolvers: ids })) }
      : { state: "divergent", distinctAnswers: signatures.size, groups: [...signatures.entries()].map(([addresses, ids]) => ({ addresses: addresses.split(","), resolvers: ids })) };

  return {
    measured: true,
    state: a.ok || aaaa.ok ? "resolved" : "failed",
    systemResolvers: systemResolvers(),
    system: {
      a: { ok: a.ok, addresses: a.addresses, elapsedMs: a.elapsedMs, error: a.error },
      aaaa: { ok: aaaa.ok, addresses: aaaa.addresses, elapsedMs: aaaa.elapsedMs, error: aaaa.error },
      authoritativeNs: ns.ok ? ns.records.slice(0, 6) : [],
      nsError: ns.ok ? null : ns.error,
      dualStack: a.ok && aaaa.ok
    },
    comparisons: comparisonResults,
    agreement
  };
}

// ---------------------------------------------------------------------------
// Connection stages: TCP -> TLS -> HTTP
// ---------------------------------------------------------------------------

export function measureTcp(address, port, timeoutMs = 5_000) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host: address, port });
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, elapsedMs: elapsedSince(started), error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, error.code || error.message));
  });
}

/**
 * Real TLS handshake against the resolved address with SNI set to the hostname.
 * Collects negotiated version, cipher and certificate facts.
 */
export function measureTls(address, port, servername, timeoutMs = 6_000) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    const socket = tls.connect({
      host: address,
      port,
      servername: net.isIP(servername) ? undefined : servername,
      rejectUnauthorized: false, // we report validation instead of aborting on it
      ALPNProtocols: ["h2", "http/1.1"]
    });

    const finish = payload => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(payload);
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish({ ok: false, elapsedMs: elapsedSince(started), error: "timeout" }));
    socket.once("error", error => finish({ ok: false, elapsedMs: elapsedSince(started), error: error.code || error.message }));
    socket.once("secureConnect", () => {
      const elapsedMs = elapsedSince(started);
      const cert = socket.getPeerCertificate(false) || {};
      const authorized = socket.authorized;
      const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      const validFrom = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
      const altNames = typeof cert.subjectaltname === "string"
        ? cert.subjectaltname.split(",").map(s => s.trim().replace(/^DNS:/i, "")).filter(Boolean).slice(0, 12)
        : [];

      finish({
        ok: true,
        elapsedMs,
        protocol: socket.getProtocol() || UNKNOWN,
        cipher: socket.getCipher()?.name || UNKNOWN,
        alpn: socket.alpnProtocol || null,
        certificate: cert.subject || cert.issuer ? {
          subject: cert.subject?.CN || null,
          issuer: cert.issuer?.O || cert.issuer?.CN || null,
          altNames,
          validFrom: Number.isFinite(validFrom) ? new Date(validFrom).toISOString() : UNKNOWN,
          validTo: Number.isFinite(validTo) ? new Date(validTo).toISOString() : UNKNOWN,
          daysRemaining: Number.isFinite(validTo) ? Math.floor((validTo - Date.now()) / 86_400_000) : null,
          expired: Number.isFinite(validTo) ? validTo < Date.now() : null
        } : null,
        // authorized reflects Node's default CA store + hostname check.
        chainTrusted: authorized === true,
        chainError: authorized ? null : (socket.authorizationError ? String(socket.authorizationError) : null),
        error: null
      });
    });
  });
}

/**
 * HTTP request pinned to the resolved address (no second DNS lookup, so the
 * measurement matches the address we validated). Headers only where possible;
 * the body is discarded immediately after first byte timing.
 */
function httpOnce(url, address, family, timeoutMs) {
  return new Promise(resolve => {
    const target = new URL(url);
    const started = performance.now();
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, totalMs: elapsedSince(started) });
    };

    const request = transport.request(target, {
      method: "GET",
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: false,
      headers: { "user-agent": "Faultline-Live/1.5", accept: "*/*", connection: "close" },
      // Pin the connection to the address we already validated for this scope.
      // Node calls this with { all: true } in some paths, which needs the
      // array form of the callback.
      lookup: (_host, options, callback) => (options && options.all
        ? callback(null, [{ address, family }])
        : callback(null, address, family))
    }, response => {
      const ttfbMs = elapsedSince(started);
      response.resume(); // discard body; we only need status + timing
      response.once("end", () => finish({
        ok: true,
        status: Number(response.statusCode) || 0,
        ttfbMs,
        location: response.headers.location || null,
        server: response.headers.server || null,
        error: null
      }));
      response.once("error", () => finish({ ok: true, status: Number(response.statusCode) || 0, ttfbMs, location: response.headers.location || null, server: response.headers.server || null, error: null }));
    });

    request.setTimeout(timeoutMs, () => { request.destroy(); finish({ ok: false, status: 0, ttfbMs: null, error: "timeout" }); });
    request.once("error", error => finish({ ok: false, status: 0, ttfbMs: null, error: error.code || error.message }));
    request.end();
  });
}

/**
 * Follows a bounded redirect chain, re-resolving and re-validating each hop
 * through the supplied resolver guard.
 */
export async function measureHttp(url, address, family, { timeoutMs = 8_000, maxRedirects = 4, resolveHop = null } = {}) {
  let current = new URL(url);
  let currentAddress = address;
  let currentFamily = family;
  const redirects = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const result = await httpOnce(current.toString(), currentAddress, currentFamily, timeoutMs);
    const isRedirect = [301, 302, 303, 307, 308].includes(result.status) && result.location;

    if (!isRedirect || hop === maxRedirects) {
      return {
        ok: result.ok && result.status > 0,
        status: result.status || null,
        ttfbMs: result.ttfbMs,
        totalMs: result.totalMs,
        finalUrl: current.toString(),
        server: result.server || null,
        redirects,
        error: result.error || (isRedirect ? "redirect-limit" : null)
      };
    }

    const next = new URL(result.location, current);
    if (!["http:", "https:"].includes(next.protocol)) {
      return { ok: false, status: result.status, ttfbMs: result.ttfbMs, totalMs: result.totalMs, finalUrl: current.toString(), redirects, error: "unsupported-redirect-scheme" };
    }
    redirects.push({ from: current.toString(), to: next.toString(), status: result.status });

    if (resolveHop) {
      const hopAddress = await resolveHop(next.hostname);
      if (!hopAddress) {
        return { ok: false, status: result.status, ttfbMs: result.ttfbMs, totalMs: result.totalMs, finalUrl: next.toString(), redirects, error: "redirect-target-blocked" };
      }
      currentAddress = hopAddress.address;
      currentFamily = hopAddress.family;
    }
    current = next;
  }
  return { ok: false, status: null, ttfbMs: null, totalMs: null, finalUrl: current.toString(), redirects, error: "redirect-limit" };
}

// ---------------------------------------------------------------------------
// ICMP + path
// ---------------------------------------------------------------------------

export function parsePing(output, attempts) {
  const text = String(output || "");
  const samples = [...text.matchAll(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/gi)].map(m => Number(m[1]));
  const lossMatch = text.match(/\((\d+(?:\.\d+)?)%\s*(?:packet\s*)?loss\)/i);
  const replies = samples.length;
  const lossPct = lossMatch ? Number(lossMatch[1]) : (attempts > 0 ? ((attempts - Math.min(replies, attempts)) / attempts) * 100 : 100);
  const avg = replies ? samples.reduce((s, v) => s + v, 0) / replies : null;
  const jitter = replies > 1
    ? samples.slice(1).map((v, i) => Math.abs(v - samples[i])).reduce((s, v) => s + v, 0) / (replies - 1)
    : null;

  return {
    attempts,
    replies,
    lossPct: Number(lossPct.toFixed(1)),
    averageMs: avg == null ? null : Number(avg.toFixed(1)),
    minMs: replies ? Math.min(...samples) : null,
    maxMs: replies ? Math.max(...samples) : null,
    jitterMs: jitter == null ? null : Number(jitter.toFixed(1)),
    samples
  };
}

export async function measurePing(host, attempts = 5) {
  const isWindows = platform() === "win32";
  const args = isWindows
    ? ["-n", String(attempts), "-w", "1500", host]
    : ["-c", String(attempts), "-W", "2", host];
  const command = isWindows ? "ping.exe" : "ping";
  const result = await runExecutable(command, args, { timeout: attempts * 1_800 + 3_000 });
  if (!result.stdout.trim()) {
    return { measured: false, state: UNKNOWN, reason: "ICMP output was unavailable on this host.", ...parsePing("", attempts) };
  }
  const parsed = parsePing(result.stdout, attempts);
  return { measured: true, state: parsed.replies > 0 ? "responded" : "no-reply", reason: null, ...parsed };
}

export function parseTraceroute(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map(line => {
      const hopMatch = line.match(/^\s*(\d+)\s+/);
      if (!hopMatch) return null;
      const ipMatch = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      const rtts = [...line.matchAll(/<?\s*(\d+(?:\.\d+)?)\s*ms/gi)].map(m => Number(m[1]));
      return {
        hop: Number(hopMatch[1]),
        ip: ipMatch?.[1] || null,
        averageRttMs: rtts.length ? Number((rtts.reduce((s, v) => s + v, 0) / rtts.length).toFixed(1)) : null,
        timedOut: !ipMatch
      };
    })
    .filter(Boolean);
}

export async function measureTraceroute(host, maxHops = 15) {
  const isWindows = platform() === "win32";
  const command = isWindows ? "tracert.exe" : "traceroute";
  const args = isWindows
    ? ["-d", "-h", String(maxHops), "-w", "800", host]
    : ["-n", "-m", String(maxHops), "-w", "2", host];
  const result = await runExecutable(command, args, { timeout: maxHops * 2_200 + 5_000 });
  if (!result.stdout.trim()) {
    return { measured: false, state: UNSUPPORTED, reason: "Traceroute is unavailable on this host.", hops: [] };
  }
  const hops = parseTraceroute(result.stdout);
  return { measured: true, state: hops.length ? "collected" : UNKNOWN, reason: null, hops };
}

// ---------------------------------------------------------------------------
// Local environment (LOCAL evidence, never transmitted externally)
// ---------------------------------------------------------------------------

async function windowsNetworkState() {
  const script = `
$default = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
$adapter = if ($default) { Get-NetAdapter -InterfaceIndex $default.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1 Name, InterfaceDescription, Status, MacAddress, LinkSpeed, MediaType, InterfaceIndex }
$v4 = if ($default) { Get-NetIPAddress -InterfaceIndex $default.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 IPAddress, PrefixLength }
$v6 = if ($default) { Get-NetIPAddress -InterfaceIndex $default.InterfaceIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 IPAddress, PrefixLength }
$vpn = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'VPN|Cisco|AnyConnect|Secure Client|WireGuard|TAP|TUN|GlobalProtect|Forti|Tailscale|ZeroTier' -or $_.InterfaceDescription -match 'VPN|Cisco|AnyConnect|Secure Client|WireGuard|TAP|TUN|GlobalProtect|Forti|Tailscale|ZeroTier') } | Select-Object Name, InterfaceDescription, InterfaceIndex)
$routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 40 DestinationPrefix, NextHop, InterfaceAlias, RouteMetric)
$neighbors = if ($default) { @(Get-NetNeighbor -InterfaceIndex $default.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Unreachable' -and $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } | Select-Object -First 48 IPAddress, LinkLayerAddress, State) } else { @() }
[pscustomobject]@{
  defaultRoute = if ($default) { [pscustomobject]@{ NextHop=$default.NextHop; InterfaceAlias=$default.InterfaceAlias; RouteMetric=$default.RouteMetric; InterfaceIndex=$default.InterfaceIndex } } else { $null }
  adapter = $adapter
  ipv4 = $v4
  ipv6 = $v6
  vpnAdapters = $vpn
  routes = $routes
  neighbors = $neighbors
} | ConvertTo-Json -Depth 6 -Compress`;

  const result = await runExecutable("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 15_000 });
  if (!result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

async function windowsWifiState() {
  const result = await runExecutable("netsh.exe", ["wlan", "show", "interfaces"], { timeout: 8_000 });
  if (!result.stdout.trim()) return null;
  const out = result.stdout;
  const grab = re => out.match(re)?.[1]?.trim() || null;
  const ssid = grab(/^\s*SSID\s*:\s*(.+)$/mi);
  const bssid = grab(/^\s*BSSID\s*:\s*([0-9a-f:-]{17})/mi);
  const signal = grab(/^\s*Signal\s*:\s*(\d+)%/mi);
  if (!ssid && !bssid) return { connected: false };
  return {
    connected: true,
    ssid,
    bssid,
    signalPct: signal ? Number(signal) : null,
    radioType: grab(/^\s*Radio type\s*:\s*(.+)$/mi),
    channel: grab(/^\s*Channel\s*:\s*(\d+)/mi) ? Number(grab(/^\s*Channel\s*:\s*(\d+)/mi)) : null,
    band: grab(/^\s*Band\s*:\s*(.+)$/mi)
  };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Genuine local environment facts. On non-Windows hosts the Windows-specific
 * fields are reported as "unsupported" rather than guessed.
 */
export async function collectLocalEnvironment() {
  const os = platform();
  const base = {
    host: hostname(),
    platform: os,
    collectedAt: new Date().toISOString(),
    resolvers: systemResolvers()
  };

  if (os !== "win32") {
    return {
      ...base,
      supported: false,
      state: UNSUPPORTED,
      reason: `Detailed adapter, Wi-Fi and route collection is implemented for Windows. This control plane is running on ${os}.`,
      adapter: null, ipv4: null, ipv6: null, gateway: null, wifi: null, vpn: null, routes: [], neighbours: []
    };
  }

  const [state, wifi] = await Promise.all([windowsNetworkState(), windowsWifiState()]);
  if (!state) {
    return { ...base, supported: true, state: UNKNOWN, reason: "Windows network state could not be read.", adapter: null, ipv4: null, ipv6: null, gateway: null, wifi: null, vpn: null, routes: [], neighbours: [] };
  }

  const vpnAdapters = asArray(state.vpnAdapters);
  return {
    ...base,
    supported: true,
    state: "collected",
    reason: null,
    adapter: state.adapter ? {
      name: state.adapter.Name || UNKNOWN,
      description: state.adapter.InterfaceDescription || UNKNOWN,
      macAddress: state.adapter.MacAddress || UNKNOWN,
      linkSpeed: state.adapter.LinkSpeed || UNKNOWN,
      mediaType: state.adapter.MediaType || UNKNOWN
    } : null,
    ipv4: state.ipv4?.IPAddress ? { address: state.ipv4.IPAddress, prefixLength: state.ipv4.PrefixLength ?? null } : null,
    ipv6: state.ipv6?.IPAddress ? { address: state.ipv6.IPAddress, prefixLength: state.ipv6.PrefixLength ?? null } : null,
    gateway: state.defaultRoute?.NextHop || null,
    interfaceAlias: state.defaultRoute?.InterfaceAlias || null,
    wifi: wifi || { connected: false },
    vpn: { active: vpnAdapters.length > 0, adapters: vpnAdapters.map(a => ({ name: a.Name, description: a.InterfaceDescription })) },
    routes: asArray(state.routes).slice(0, 40).map(r => ({
      destination: r.DestinationPrefix, nextHop: r.NextHop, interfaceAlias: r.InterfaceAlias, metric: r.RouteMetric
    })),
    neighbours: asArray(state.neighbors).map(n => ({ ip: n.IPAddress, mac: n.LinkLayerAddress, state: n.State }))
  };
}

export const __testing = { runExecutable };
