const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const domainLabels = {
  healthy: "No fault detected",
  local_network: "Local network / Wi-Fi",
  dns: "DNS resolution",
  vpn: "VPN / route configuration",
  upstream: "ISP / upstream network",
  access_path: "Endpoint path / policy",
  target_service: "Target service",
  inconclusive: "Inconclusive"
};

function finding(label, status, detail, value = null) {
  return { label, status, detail, value };
}

export function diagnose(input) {
  const evidence = [];
  const scores = {
    local_network: 0,
    dns: 0,
    vpn: 0,
    upstream: 0,
    access_path: 0,
    target_service: 0
  };

  const gatewayLoss = Number(input.gatewayLoss ?? 0);
  const gatewayLatencyMs = Number(input.gatewayLatencyMs ?? 0);
  const upstreamLoss = Number(input.upstreamLoss ?? 0);
  const jitterMs = Number(input.jitterMs ?? 0);
  const externalProbePresent = typeof input.externalProbeHealthy === "boolean";

  if (gatewayLoss >= 5) {
    scores.local_network += 70;
    evidence.push(finding("Gateway packet loss", "fail", "Loss is already present before traffic leaves the local network.", `${gatewayLoss.toFixed(1)}%`));
  } else {
    evidence.push(finding("Gateway packet loss", "pass", "The local path to the default gateway is stable.", `${gatewayLoss.toFixed(1)}%`));
  }

  if (gatewayLatencyMs >= 40) {
    scores.local_network += 25;
    evidence.push(finding("Gateway latency", "warn", "Latency to the local gateway is higher than expected.", `${gatewayLatencyMs.toFixed(0)} ms`));
  } else {
    evidence.push(finding("Gateway latency", "pass", "Local gateway latency is within the expected range.", `${gatewayLatencyMs.toFixed(0)} ms`));
  }

  if (input.dnsResolved === false && input.directIpReachable === true) {
    scores.dns += 95;
    evidence.push(finding("DNS resolution", "fail", "The destination works by IP but not by hostname, strongly isolating the fault to DNS."));
  } else if (input.dnsResolved === false) {
    scores.dns += 45;
    evidence.push(finding("DNS resolution", "fail", "Hostname resolution failed, although another connectivity issue may also be present."));
  } else {
    evidence.push(finding("DNS resolution", "pass", "Hostname resolution completed successfully."));
  }

  if (input.vpnRequired === true) {
    if (input.vpnConnected === false) {
      scores.vpn += 90;
      evidence.push(finding("VPN session", "fail", "The target requires the VPN, but the tunnel is not connected."));
    } else {
      evidence.push(finding("VPN session", "pass", "The required VPN tunnel is connected."));
    }

    if (input.vpnConnected === true && input.expectedRoutePresent === false) {
      scores.vpn += 100;
      evidence.push(finding("VPN route", "fail", "The VPN is connected but the expected destination route is missing."));
    } else if (input.expectedRoutePresent === true) {
      evidence.push(finding("VPN route", "pass", "The expected destination route is present."));
    }
  }

  if (gatewayLoss < 2 && upstreamLoss >= 5) {
    scores.upstream += 80;
    evidence.push(finding("Upstream packet loss", "fail", "Loss begins after the local gateway, shifting the fault domain upstream.", `${upstreamLoss.toFixed(1)}%`));
  } else if (upstreamLoss >= 2) {
    scores.upstream += 35;
    evidence.push(finding("Upstream packet loss", "warn", "Elevated packet loss is visible on the endpoint path.", `${upstreamLoss.toFixed(1)}%`));
  } else {
    evidence.push(finding("Upstream packet loss", "pass", "No material packet loss is visible on the measured endpoint path.", `${upstreamLoss.toFixed(1)}%`));
  }

  if (jitterMs >= 50 && gatewayLoss < 2) {
    scores.upstream += 20;
    evidence.push(finding("Jitter", "warn", "High latency variation may affect voice and video traffic.", `${jitterMs.toFixed(0)} ms`));
  } else {
    evidence.push(finding("Jitter", "pass", "Latency variation is within the expected range.", `${jitterMs.toFixed(0)} ms`));
  }

  if (!externalProbePresent) {
    evidence.push(finding("Remote probe", "neutral", "No independent probe has joined this diagnostic run yet."));
  } else if (input.externalProbeHealthy === true) {
    evidence.push(finding(
      "Remote probe",
      "pass",
      "The target is reachable from an independent vantage point.",
      input.externalProbeLatencyMs != null ? `${Number(input.externalProbeLatencyMs).toFixed(0)} ms` : null
    ));

    if (input.targetReachable === false && gatewayLoss < 2 && upstreamLoss < 5 && input.dnsResolved !== false && !(input.vpnRequired && input.expectedRoutePresent === false)) {
      scores.access_path += 85;
      evidence.push(finding("Vantage comparison", "fail", "The remote probe can reach the target while this endpoint cannot, isolating the problem to the endpoint-specific path or policy."));
    }

    if (input.targetReachable === false && upstreamLoss >= 5) {
      scores.upstream += 15;
    }
  } else {
    evidence.push(finding(
      "Remote probe",
      "fail",
      "The independent probe cannot reach the target.",
      input.externalProbeLatencyMs != null ? `${Number(input.externalProbeLatencyMs).toFixed(0)} ms` : null
    ));

    if (input.targetReachable === false && input.internetReachable === true) {
      scores.target_service += 90;
      evidence.push(finding("Vantage comparison", "fail", "Both endpoint and remote probe fail while general internet access remains available."));
    }
  }

  if (input.targetReachable === true) {
    evidence.push(finding("Target service", "pass", "The target service is reachable from this endpoint.", input.targetHttpMs ? `${Number(input.targetHttpMs).toFixed(0)} ms` : null));
  } else if (!externalProbePresent) {
    evidence.push(finding("Target reachability", "fail", "The endpoint cannot reach the target; an independent vantage point is needed to separate path and service faults."));
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [domain, rawScore] = ranked[0];
  const allHealthy =
    input.targetReachable !== false &&
    input.dnsResolved !== false &&
    gatewayLoss < 2 &&
    upstreamLoss < 2 &&
    (!input.vpnRequired || (input.vpnConnected && input.expectedRoutePresent !== false));

  let faultDomain = domain;
  let confidence = clamp(Math.round(rawScore), 0, 99);

  if (allHealthy && rawScore < 25) {
    faultDomain = "healthy";
    confidence = externalProbePresent && input.externalProbeHealthy === true ? 96 : 92;
  } else if (rawScore < 35) {
    faultDomain = "inconclusive";
    confidence = externalProbePresent ? 55 : 48;
  }

  if (externalProbePresent && rawScore >= 35) {
    confidence = clamp(confidence + 4, 0, 99);
  }

  return {
    faultDomain,
    faultDomainLabel: domainLabels[faultDomain],
    confidence,
    severity: faultDomain === "healthy" ? "healthy" : faultDomain === "inconclusive" || confidence < 60 ? "warning" : "degraded",
    summary: summaryFor(faultDomain),
    evidence,
    actions: actionPlan(faultDomain, input),
    generatedAt: new Date().toISOString()
  };
}

function summaryFor(domain) {
  return {
    healthy: "No material fault is visible in the current measurements.",
    local_network: "The evidence indicates degradation before traffic leaves the local network.",
    dns: "Connectivity is available, but name resolution is preventing the destination from being reached normally.",
    vpn: "The VPN session or route state is preventing traffic from taking the expected corporate path.",
    upstream: "The local network appears healthy and degradation begins further upstream on the endpoint path.",
    access_path: "The target is healthy from the remote probe but unreachable from this endpoint, pointing to an endpoint-specific route, policy or access-path problem.",
    target_service: "Independent vantage points agree that the target service is not responding as expected.",
    inconclusive: "The current evidence does not isolate the problem to one fault domain with enough confidence."
  }[domain];
}

function actionPlan(domain, input) {
  return {
    healthy: ["Repeat the diagnostic while the issue is actively occurring.", "Capture application-specific timestamps if the user still experiences degradation."],
    local_network: ["Test over Ethernet or move closer to the wireless access point.", "Check local congestion, signal quality and gateway health before escalating externally."],
    dns: ["Validate the configured DNS resolver and test the target hostname directly.", "Compare resolution against an approved alternate resolver before changing network routes."],
    vpn: [input.vpnConnected === false ? "Reconnect the required VPN tunnel." : "Validate split-tunnel policy and restore the missing destination route.", "Re-run the diagnostic after the VPN route table changes."],
    upstream: ["Escalate with the measured loss point, timestamps and route evidence.", "Compare against the remote probe result to distinguish endpoint-path degradation from a wider service issue."],
    access_path: ["Compare endpoint routing, proxy, firewall and security policy against a working path.", "Repeat from a second endpoint on the same access network before escalating the target service."],
    target_service: ["Check the target service status and application edge logs.", "Use the two-vantage failure evidence when escalating to the service owner."],
    inconclusive: ["Collect another sample while the fault is active.", "Add or repeat an independent remote probe to improve fault-domain confidence."]
  }[domain];
}
