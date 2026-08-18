import { lookup } from "node:dns/promises";
import { hostname, platform } from "node:os";
import net from "node:net";
import { performance } from "node:perf_hooks";

export function normaliseProbeTarget(value, requestedPort) {
  const input = String(value || "").trim();
  if (!input) throw new Error("A target hostname, IP address or URL is required.");

  let url = null;
  let host = input;
  let port = Number(requestedPort || 0) || null;

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    url = parsed.toString();
    host = parsed.hostname;
    if (!port) port = Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443));
  } else {
    host = input.replace(/^\[|\]$/g, "");
    if (!port) port = 443;
    if (!net.isIP(host)) url = `https://${host}/`;
  }

  return { input, host, port, url };
}

export async function probeDns(host) {
  const started = performance.now();
  try {
    const addresses = await lookup(host, { all: true });
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

export function probeTcp(host, port, timeoutMs = 3500) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
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

export async function probeHttp(url, timeoutMs = 6000) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Faultline-Remote-Probe/0.3" }
    });
    const elapsedMs = Number((performance.now() - started).toFixed(1));
    await response.body?.cancel().catch(() => {});
    return {
      ok: response.status < 500,
      elapsedMs,
      status: response.status,
      finalUrl: response.url
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      error: error.name || error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectRemoteProbe(options) {
  const target = normaliseProbeTarget(options.target, options.port);
  const dns = await probeDns(target.host);
  const [tcp, http] = await Promise.all([
    probeTcp(target.host, target.port),
    target.url ? probeHttp(target.url) : Promise.resolve(null)
  ]);

  return {
    runId: options.runId,
    probe: {
      name: options.name || hostname(),
      version: "0.3.0",
      platform: platform(),
      hostname: hostname()
    },
    metrics: {
      dnsResolved: dns.ok,
      dnsLookupMs: dns.elapsedMs,
      targetReachable: Boolean(tcp.ok || http?.ok),
      targetTcpMs: tcp.elapsedMs,
      targetHttpMs: http?.elapsedMs ?? null
    },
    telemetry: {
      collectedAt: new Date().toISOString(),
      target,
      resolvedAddresses: dns.addresses,
      targetProbe: { tcp, http }
    }
  };
}
