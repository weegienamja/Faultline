import { execFile } from "node:child_process";
import { resolve4, resolve6 } from "node:dns/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const execFileAsync = promisify(execFile);
function elapsed(started) { return Number((performance.now() - started).toFixed(1)); }
function errorValue(error) { return error?.code || error?.name || error?.message || "error"; }

async function resolveFamily(host, family) {
  const started = performance.now();
  try {
    const records = family === 4 ? await resolve4(host, { ttl: true }) : await resolve6(host, { ttl: true });
    return { family, ok: records.length > 0, elapsedMs: elapsed(started), records };
  } catch (error) {
    return { family, ok: false, elapsedMs: elapsed(started), records: [], error: errorValue(error) };
  }
}

export async function resolveDualStack(host) {
  const [ipv4, ipv6] = await Promise.all([resolveFamily(host, 4), resolveFamily(host, 6)]);
  return { host, ipv4, ipv6 };
}

export function tcpAddressProbe(address, port, family, timeoutMs = 3000) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host: address, port, family });
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ address, family, port, ok, elapsedMs: elapsed(started), error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, errorValue(error)));
  });
}

export function tlsHandshakeProbe({ host, address = null, port = 443, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    const socket = tls.connect({
      host: address || host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: true,
      timeout: timeoutMs
    });
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      const certificate = ok ? socket.getPeerCertificate() : null;
      const result = {
        ok,
        elapsedMs: elapsed(started),
        error,
        authorized: Boolean(socket.authorized),
        authorizationError: socket.authorizationError || null,
        protocol: ok ? socket.getProtocol() : null,
        cipher: ok ? socket.getCipher() : null,
        alpnProtocol: ok ? socket.alpnProtocol || null : null,
        certificate: certificate && Object.keys(certificate).length ? {
          subject: certificate.subject || null,
          issuer: certificate.issuer || null,
          validFrom: certificate.valid_from || null,
          validTo: certificate.valid_to || null,
          fingerprint256: certificate.fingerprint256 || null
        } : null
      };
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, errorValue(error)));
  });
}

export function httpStageProbe(input, timeoutMs = 7000) {
  return new Promise(resolve => {
    const url = input instanceof URL ? input : new URL(input);
    const client = url.protocol === "https:" ? https : http;
    const started = performance.now();
    const timings = { socketMs: null, dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
    let dnsAt = null;
    let tcpAt = null;
    let settled = false;

    const request = client.request(url, { method: "GET", headers: { "user-agent": "Faultline/1.4-deep-diagnostics", accept: "*/*" } }, response => {
      timings.ttfbMs = elapsed(started);
      response.resume();
      response.once("end", () => finish(true, { status: response.statusCode, headersReceived: true }));
    });
    const finish = (ok, extra = {}) => {
      if (settled) return;
      settled = true;
      timings.totalMs = elapsed(started);
      request.destroy();
      resolve({ ok, url: url.toString(), timings, ...extra });
    };
    request.setTimeout(timeoutMs, () => finish(false, { error: "timeout" }));
    request.once("socket", socket => {
      timings.socketMs = elapsed(started);
      socket.once("lookup", () => { dnsAt = performance.now(); timings.dnsMs = elapsed(started); });
      socket.once("connect", () => {
        tcpAt = performance.now();
        timings.tcpMs = elapsed(started);
        if (dnsAt != null) timings.tcpAfterDnsMs = Number((tcpAt - dnsAt).toFixed(1));
      });
      socket.once("secureConnect", () => {
        timings.tlsMs = elapsed(started);
        if (tcpAt != null) timings.tlsAfterTcpMs = Number((performance.now() - tcpAt).toFixed(1));
      });
    });
    request.once("error", error => finish(false, { error: errorValue(error) }));
    request.end();
  });
}

export function parseWindowsMtuPing(output) {
  const text = String(output || "");
  if (/Packet needs to be fragmented|needs to be fragmented/i.test(text)) return { fits: false, reason: "fragmentation-required" };
  if (/Reply from/i.test(text)) return { fits: true, reason: "reply" };
  return { fits: false, reason: "no-reply" };
}

export async function discoverWindowsPathMtu(host, { minimum = 1200, maximum = 1500 } = {}) {
  if (platform() !== "win32") return null;
  let low = Math.max(576, Number(minimum));
  let high = Math.min(9000, Number(maximum));
  let best = null;
  const attempts = [];
  while (low <= high && attempts.length < 10) {
    const mtu = Math.floor((low + high) / 2);
    const payloadBytes = Math.max(0, mtu - 28);
    let stdout = "";
    try {
      const result = await execFileAsync("ping.exe", ["-n", "1", "-w", "1200", "-f", "-l", String(payloadBytes), host], { windowsHide: true, timeout: 2500 });
      stdout = result.stdout || "";
    } catch (error) {
      stdout = error.stdout || error.stderr || "";
    }
    const parsed = parseWindowsMtuPing(stdout);
    attempts.push({ mtuBytes: mtu, payloadBytes, ...parsed });
    if (parsed.fits) { best = mtu; low = mtu + 1; } else { high = mtu - 1; }
  }
  return { pathMtuBytes: best, minimumTested: minimum, maximumTested: maximum, attempts };
}

export async function collectDeepDiagnostics(target, { mtuProbe = discoverWindowsPathMtu } = {}) {
  const host = target.host || target.hostname || String(target);
  const port = Number(target.port || 443);
  const dualStack = await resolveDualStack(host);
  const v4Address = dualStack.ipv4.records[0]?.address || null;
  const v6Address = dualStack.ipv6.records[0]?.address || null;
  const [ipv4Tcp, ipv6Tcp] = await Promise.all([
    v4Address ? tcpAddressProbe(v4Address, port, 4) : Promise.resolve(null),
    v6Address ? tcpAddressProbe(v6Address, port, 6) : Promise.resolve(null)
  ]);
  const tlsResult = (port === 443 || String(target.url || "").startsWith("https://"))
    ? await tlsHandshakeProbe({ host, address: v4Address || v6Address, port })
    : null;
  const httpResult = target.url ? await httpStageProbe(target.url) : null;
  const pathMtu = typeof mtuProbe === "function" ? await mtuProbe(host) : null;

  return {
    collectedAt: new Date().toISOString(),
    dualStack: { ...dualStack, ipv4Tcp, ipv6Tcp },
    tls: tlsResult,
    http: httpResult,
    pathMtu,
    summary: {
      ipv4Available: dualStack.ipv4.ok,
      ipv6Available: dualStack.ipv6.ok,
      ipv4Reachable: ipv4Tcp?.ok ?? null,
      ipv6Reachable: ipv6Tcp?.ok ?? null,
      tlsOk: tlsResult?.ok ?? null,
      tlsHandshakeMs: tlsResult?.elapsedMs ?? null,
      httpTtfbMs: httpResult?.timings?.ttfbMs ?? null,
      pathMtuBytes: pathMtu?.pathMtuBytes ?? null
    }
  };
}
