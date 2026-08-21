// The recorded demo investigations.
//
// Three faults that a hosted deployment genuinely cannot reproduce, because
// each one lives on the endpoint: a lost IPv6 path, a resolver that answers
// with a different address, and a VPN that takes the default route. Vercel has
// no visitor LAN, no VPN adapter and no second egress interface, so the honest
// way to demonstrate the endpoint half of Faultline is to REPLAY a recorded
// investigation through the real engines rather than to fake a result.
//
// Each entry supplies two things:
//
//   scenario   the Flight Recorder fixture, replayed by src/demo/replay.mjs
//              through the production recorder on a virtual clock
//   world      a pure model of how the recorded endpoint answered a connection,
//              used as the scripted trial source for the production Network
//              Bisect engine
//
// The world model is deliberately written in terms of the CONNECTION PLAN, not
// in terms of experiments or hypotheses. It answers "if you had connected like
// this, what would have happened", and has no idea which experiment is running
// or what the engine currently believes. The engine's conclusion is therefore
// something it derived, not something written here.
//
// Everything these produce is labelled simulated at every layer: the samples,
// the incident, the Bisect attachment and the exported capsule.

import { IFACE, scriptedInterface, STAGE } from "./replay.mjs";

/** The resolvers Network Bisect is allowed to vary in a replayed run. */
const PUBLIC_RESOLVERS = Object.freeze(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);

const fail = (stage, reason) => ({ verdict: "fail", stage, reason });
const pass = reason => ({ verdict: "pass", reason: reason || null });

export const DEMO_INCIDENTS = Object.freeze([
  {
    id: "FLR-DEMO-IPV6",
    slug: "ipv6-path-failure",
    scenario: "ipv6-path-loss",
    title: "IPv6 path failure",
    subtitle: "A dual-stack service stops working while IPv4 still connects",
    faultDomainHint: "Endpoint IPv6 capability",
    /** Why this cannot be a live hosted measurement. */
    whyRecorded:
      "The fault is the absence of a working IPv6 path on the endpoint's own network. A hosted vantage has its own connectivity and cannot lose a visitor's IPv6 route, so this investigation is replayed rather than measured.",
    story: {
      capture:
        "The Flight Recorder was already sampling the target when it stopped answering. It kept the healthy window that preceded the failure, so there is something to compare against.",
      isolate:
        "The target, the hostname, the port and the service are all held constant. Only the address family is varied. If changing it changes the outcome, the fault is specific to that family.",
      explain:
        "The deterministic engine reports what the experiment established. Nothing infers a cause from the fact that two things happened at the same time.",
      preserve:
        "The incident, the isolation run and the reasoning transcript export as one self-contained Incident Capsule."
    },
    bisect: {
      target: "example.com",
      port: 443,
      resolvers: PUBLIC_RESOLVERS,
      answerSets: {
        v4: ["93.184.216.34"],
        v6: ["2606:2800:220:1:248:1893:25c8:1946"]
      },
      interfaces: [
        scriptedInterface({
          name: "Ethernet",
          address: "192.168.1.24",
          classification: IFACE.PRIMARY,
          ownsDefaultRoute: true,
          isBestDefault: true
        })
      ],
      /**
       * The recorded endpoint is dual-stack and prefers IPv6, and its IPv6 path
       * is gone. An unpinned connection therefore takes the broken family.
       */
      world(plan) {
        const v6 = plan.family === 6 || (plan.address && plan.address.includes(":"));
        const v4 = plan.family === 4 || (plan.address && !plan.address.includes(":"));
        if (v6) return fail(STAGE.TCP, "ENETUNREACH");
        if (v4) return pass("connected over IPv4");
        // Address-family unpinned: RFC 6724 puts the AAAA answer first.
        return fail(STAGE.TCP, "ENETUNREACH");
      }
    }
  },

  {
    id: "FLR-DEMO-DNS",
    slug: "dns-resolver-disagreement",
    scenario: "dns-resolver-split",
    title: "DNS resolver disagreement",
    subtitle: "Resolution keeps succeeding, but two resolvers return different answers",
    faultDomainHint: "Resolver-dependent answer",
    whyRecorded:
      "The fault is which answer the ENDPOINT's configured resolver returns. A hosted vantage uses its own resolvers and cannot be handed a split-horizon answer on a visitor's behalf, so this investigation is replayed rather than measured.",
    story: {
      capture:
        "DNS never fails during this incident, so a pass/fail DNS check reports it as healthy throughout. What the recorder captured is that the ANSWER changed at the same moment the service became unreachable.",
      isolate:
        "Two conditions changed together: the resolver, and the address it returned. Bisect varies them independently, because 'they changed at the same time' is not evidence about which one matters.",
      explain:
        "A confirmed discriminator says changing that one condition changes the outcome. It does not say the change caused the fault, and the engine does not claim it did.",
      preserve:
        "Both answers, both resolvers and the confirmation sequence are preserved in the capsule, which is what an escalation to whoever runs the resolver actually needs."
    },
    bisect: {
      target: "service.example.com",
      port: 443,
      resolvers: PUBLIC_RESOLVERS,
      // Both answers really were seen during the incident: the public one before
      // the resolver changed, the split-horizon one after.
      answerSets: { v4: ["203.0.113.24", "10.44.12.9"], v6: [] },
      interfaces: [
        scriptedInterface({
          name: "Wi-Fi",
          address: "192.168.1.24",
          classification: IFACE.WIFI,
          ownsDefaultRoute: true,
          isBestDefault: true
        })
      ],
      /**
       * The endpoint's own resolver is the internal one, which answers with the
       * split-horizon address. Any public resolver answers with the public one.
       */
      world(plan) {
        if (plan.family === 6) return fail(STAGE.DNS, "no AAAA record for this name");
        const resolver = plan.resolver || "10.20.0.53";
        const answer = plan.address || (resolver === "10.20.0.53" ? "10.44.12.9" : "203.0.113.24");
        if (answer === "10.44.12.9") return fail(STAGE.TCP, "ETIMEDOUT");
        return pass(`connected to ${answer}`);
      }
    }
  },

  {
    id: "FLR-DEMO-VPN",
    slug: "vpn-routing-regression",
    scenario: "vpn-route-loss",
    title: "VPN routing regression",
    subtitle: "A tunnel takes the default route and the service stops answering",
    faultDomainHint: "Endpoint egress path",
    whyRecorded:
      "The fault is which local interface owns the default route. A hosted vantage has no VPN adapter and no second egress to bind to, so this investigation is replayed rather than measured.",
    story: {
      capture:
        "The recorder saw four things move within one sampling interval: the active interface, the default route, the default gateway and the VPN state. All four are recorded; none of them is called a cause.",
      isolate:
        "Route selection is not something an experiment can set directly, but the interface it selects is. Bisect binds the connection to each egress in turn and compares.",
      explain:
        "Binding to the physical interface restores the connection and binding to the tunnel does not, held across interleaved A/B pairs so a network that simply recovered would not pass as a finding.",
      preserve:
        "The before and after routing state travels with the capsule, which is what makes this arguable with whoever owns the tunnel policy."
    },
    bisect: {
      target: "api.example.com",
      port: 443,
      resolvers: PUBLIC_RESOLVERS,
      answerSets: { v4: ["203.0.113.90"], v6: [] },
      interfaces: [
        scriptedInterface({
          name: "Ethernet",
          address: "192.168.1.24",
          classification: IFACE.ETHERNET
        }),
        scriptedInterface({
          name: "Corp VPN",
          address: "10.8.0.6",
          classification: IFACE.VPN,
          ownsDefaultRoute: true,
          isBestDefault: true
        })
      ],
      /** During the incident the tunnel owns the default route, and it drops. */
      world(plan) {
        if (plan.family === 6) return fail(STAGE.DNS, "no AAAA record for this name");
        const source = plan.localAddress || "10.8.0.6";
        if (source === "10.8.0.6") return fail(STAGE.TCP, "ETIMEDOUT");
        return pass(`connected via ${source}`);
      }
    }
  }
]);

export function findDemoIncident(reference) {
  const value = String(reference || "").trim().toLowerCase();
  return DEMO_INCIDENTS.find(entry => entry.id.toLowerCase() === value || entry.slug === value) || null;
}
