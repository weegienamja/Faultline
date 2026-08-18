export const incidents = [
  {
    id: "FL-1042",
    title: "Microsoft 365 intermittent calls",
    customer: "Northstar Design",
    target: "Microsoft 365",
    location: "Remote user · Glasgow",
    connection: "Wi-Fi",
    scenario: "upstream",
    metrics: {
      gatewayLoss: 0.1,
      gatewayLatencyMs: 3,
      dnsResolved: true,
      directIpReachable: true,
      internetReachable: true,
      vpnRequired: false,
      upstreamLoss: 8.4,
      jitterMs: 71,
      externalProbeHealthy: true,
      targetReachable: true,
      targetHttpMs: 39
    }
  },
  {
    id: "FL-1040",
    title: "Cloud calling audio breaking up",
    customer: "Westbridge Accountancy",
    target: "Hosted voice service",
    location: "Remote user · Hamilton",
    connection: "Ethernet",
    scenario: "upstream",
    metrics: {
      gatewayLoss: 0.2,
      gatewayLatencyMs: 4,
      dnsResolved: true,
      directIpReachable: true,
      internetReachable: true,
      vpnRequired: false,
      upstreamLoss: 7.6,
      jitterMs: 64,
      externalProbeHealthy: true,
      targetReachable: true,
      targetHttpMs: 44
    }
  },
  {
    id: "FL-1038",
    title: "Video calls degrade after connection",
    customer: "Calder Systems",
    target: "Video collaboration service",
    location: "Remote user · Motherwell",
    connection: "Wi-Fi",
    scenario: "upstream",
    metrics: {
      gatewayLoss: 0,
      gatewayLatencyMs: 4,
      dnsResolved: true,
      directIpReachable: true,
      internetReachable: true,
      vpnRequired: false,
      upstreamLoss: 9.1,
      jitterMs: 67,
      externalProbeHealthy: true,
      targetReachable: true,
      targetHttpMs: 42
    }
  },
  {
    id: "FL-1041",
    title: "CRM hostname unavailable",
    customer: "Apex Legal",
    target: "crm.apex.example",
    location: "Office · Edinburgh",
    connection: "Ethernet",
    scenario: "dns",
    metrics: {
      gatewayLoss: 0,
      gatewayLatencyMs: 1,
      dnsResolved: false,
      directIpReachable: true,
      internetReachable: true,
      vpnRequired: false,
      upstreamLoss: 0.1,
      jitterMs: 4,
      externalProbeHealthy: true,
      targetReachable: false
    }
  },
  {
    id: "FL-1039",
    title: "Internal app unreachable",
    customer: "Harbour Finance",
    target: "10.40.12.25",
    location: "Remote user · Manchester",
    connection: "Cisco Secure Client",
    scenario: "vpn",
    metrics: {
      gatewayLoss: 0,
      gatewayLatencyMs: 5,
      dnsResolved: true,
      directIpReachable: false,
      internetReachable: true,
      vpnRequired: true,
      vpnConnected: true,
      expectedRoutePresent: false,
      upstreamLoss: 0.3,
      jitterMs: 9,
      externalProbeHealthy: true,
      targetReachable: false
    }
  },
  {
    id: "FL-1037",
    title: "Video meetings unstable",
    customer: "Clyde Manufacturing",
    target: "Web conferencing",
    location: "Remote user · Paisley",
    connection: "Wi-Fi",
    scenario: "local_network",
    metrics: {
      gatewayLoss: 12.7,
      gatewayLatencyMs: 64,
      dnsResolved: true,
      directIpReachable: true,
      internetReachable: true,
      vpnRequired: false,
      upstreamLoss: 13.1,
      jitterMs: 82,
      externalProbeHealthy: true,
      targetReachable: true,
      targetHttpMs: 210
    }
  }
];
