import http from "node:http";
import https from "node:https";
import { hostname, platform } from "node:os";
import net from "node:net";
import { performance } from "node:perf_hooks";
import {
  assertPortAllowed,
  normaliseProbeScope,
  resolveProbeTarget
} from "../security/target.mjs";

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

export async function probeDns(host, scope = "public") {
  const started = performance.now();
  try {
    const addresses = await resolveProbeTarget(host, scope);
    return {
      ok: addresses.length > 0,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      addresses: addresses.map(item => ({ address: item.address, family: item.family }))
    };
  } catch (error) {
    if (error.code === "TARGET_POLICY") throw error;
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

function requestHttpOnce(url, address, family, timeoutMs) {
  return new Promise(resolve => {
    const target = new URL(url);
    const started = performance.now();
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ...result, elapsedMs: Number((performance.now() - started).toFixed(1)) });
    };

    const request = transport.request(target, {
      method: "GET",
      headers: { "user-agent": "Faultline-Remote-Probe/1.5" },
      servername: target.hostname,
      // Node passes { all: true } on some paths; the array callback form is
      // required there or the request fails with ERR_INVALID_IP_ADDRESS.
      lookup: (_hostname, options, callback) => (options && options.all
        ? callback(null, [{ address, family }])
        : callback(null, address, family))
    }, response => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location || null;
      response.resume();
      finish({ ok: status > 0 && status < 500, status, location });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish({ ok: false, status: 0, error: "timeout" });
    });
    request.once("error", error => finish({ ok: false, status: 0, error: error.code || error.message }));
    request.end();
  });
}

export async function probeHttp(url, options = {}) {
  if (!url) return null;
  const config = typeof options === "number" ? { timeoutMs: options } : options;
  const scope = normaliseProbeScope(config.scope || "public");
  const timeoutMs = Number(config.timeoutMs || 6000);
  const maxRedirects = Number.isInteger(config.maxRedirects) ? config.maxRedirects : 4;
  const started = performance.now();
  let current = new URL(url);
  const redirects = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!['http:', 'https:'].includes(current.protocol)) {
      const error = new Error("Remote probe HTTP redirects must remain HTTP or HTTPS.");
      error.code = "TARGET_POLICY";
      throw error;
    }

    const port = Number(current.port || (current.protocol === "http:" ? 80 : 443));
    assertPortAllowed(port, scope);
    const addresses = await resolveProbeTarget(current.hostname, scope);
    const selected = addresses[0];
    const result = await requestHttpOnce(current.toString(), selected.address, selected.family, timeoutMs);
    const redirect = [301, 302, 303, 307, 308].includes(result.status) && result.location;

    if (!redirect) {
      return {
        ok: result.ok,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        status: result.status || null,
        finalUrl: current.toString(),
        redirects,
        error: result.error || null
      };
    }

    if (hop === maxRedirects) {
      return {
        ok: false,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        status: result.status,
        finalUrl: current.toString(),
        redirects,
        error: "redirect-limit"
      };
    }

    const next = new URL(result.location, current);
    redirects.push({ from: current.toString(), to: next.toString(), status: result.status });
    current = next;
  }

  return null;
}

export async function collectRemoteProbe(options) {
  const scope = normaliseProbeScope(options.scope || "public");
  const target = normaliseProbeTarget(options.target, options.port);
  assertPortAllowed(target.port, scope);
  const dns = await probeDns(target.host, scope);
  const selected = dns.addresses[0] || null;
  const [tcp, httpResult] = await Promise.all([
    selected ? probeTcp(selected.address, target.port) : Promise.resolve({ ok: false, elapsedMs: 0, error: "dns-failed" }),
    target.url ? probeHttp(target.url, { scope }) : Promise.resolve(null)
  ]);

  return {
    sessionId: options.sessionId,
    probe: {
      name: options.name || hostname(),
      version: "1.5-preview",
      platform: platform(),
      hostname: hostname(),
      scope
    },
    metrics: {
      dnsResolved: dns.ok,
      dnsLookupMs: dns.elapsedMs,
      targetReachable: Boolean(tcp.ok || httpResult?.ok),
      targetTcpMs: tcp.elapsedMs,
      targetHttpMs: httpResult?.elapsedMs ?? null
    },
    telemetry: {
      collectedAt: new Date().toISOString(),
      target,
      scope,
      resolvedAddresses: dns.addresses,
      targetProbe: { tcp, http: httpResult }
    }
  };
}
