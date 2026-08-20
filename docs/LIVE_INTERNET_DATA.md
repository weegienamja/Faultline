# Live network and Internet data

Faultline's demo incidents exist to illustrate known failure shapes. This document
covers the **live** path: real measurements taken from the machine running the
control plane, real measurements taken from public vantage points, and public
Internet context retrieved from open data sources.

> **The deterministic engine stays authoritative.** Public Internet intelligence
> can corroborate evidence. It never establishes root cause, and it never changes
> a fault domain.

---

## Evidence classes

Every value the live panel renders is tagged with the class it belongs to. The
separation is enforced in code, not just in wording.

| Class | Meaning | Produced by |
|---|---|---|
| **observed** | A measurement actually taken | `src/live/measure.mjs` (local), Globalping (remote vantages) |
| **inferred** | Derived from observed local state | `src/topology/infer.mjs` |
| **deterministic** | The authoritative fault-domain conclusion | `src/engine/diagnose.mjs` |
| **statistical** | Similarity between incidents | `public/intelligence.js` (unchanged) |
| **external** | Public routing/ownership/outage context | `src/integrations/*` |

`src/live/diagnostic.mjs` builds the deterministic input in
`buildDeterministicMetrics()`. Only *observed* measurements appear there. A test
(`tests/integrations-boundary.test.mjs`) asserts that no routing, RPKI, outage or
network-metadata field can reach it.

### The one deliberate exception

Globalping measurements **do** feed the deterministic engine, via the
`externalProbeHealthy` / `externalProbeLatencyMs` inputs that the correlation
engine already defines for an independent second vantage. This is a genuine ICMP
measurement from an independent network, not "intelligence". It is exactly the
kind of evidence the two-vantage design was built for. RIPEstat, IODA, PeeringDB,
RIPE Atlas and Cloudflare Radar are **never** wired into diagnosis.

---

## Sources

| Source | Credential | What it contributes | Cache | Class |
|---|---|---|---|---|
| Local measurement | none | DNS, TCP, TLS, HTTP, ICMP, traceroute, adapter/Wi-Fi/VPN/route state | none | observed |
| [RIPEstat](https://stat.ripe.net/docs/data_api) | **none** | prefix, origin ASN, holder, RPKI validity, RIS visibility, BGP activity | 5 min (1 min activity) | external |
| [Globalping](https://globalping.io/docs/api.globalping.io) | **none** (rate-limited per IP) | live ping from public vantages | 3 min | observed (remote) |
| [RIPE Atlas](https://atlas.ripe.net/docs/apis/rest-api-manual/) | **none** for public probe metadata | connected public probes near the target network | 30 min | external |
| [IODA](https://api.ioda.inetintel.cc.gatech.edu/v2) | **none** | outage/anomaly alerts for an ASN or country | 5 min | external |
| [PeeringDB](https://www.peeringdb.com/apidocs/) | **none** for read | self-published network metadata, IX presence | 60 min | external |
| [Cloudflare Radar](https://developers.cloudflare.com/radar/) | **required, optional integration** | outage annotations | 10 min | external |

**Only Cloudflare Radar needs a credential.** Set
`FAULTLINE_CLOUDFLARE_RADAR_TOKEN` to enable it. Without it the panel shows
`Cloudflare Radar - Not configured` and no request is made. Everything else works
with no account, no key and no cost.

### Data-call detail

RIPEstat calls used, all verified against the live API:

```text
network-info      resolved prefix + origin ASN for an IP
as-overview       ASN holder/name, announcement state, registry block
rpki-validation   RPKI validity for (origin ASN, prefix)
routing-status    RIS peer visibility, first/last seen
bgp-updates       announcements/withdrawals in a bounded window
```

Traceroute hop enrichment uses a lighter path (`lookupHopOwner`): one
`network-info` per public hop plus one **cached** `as-overview` per distinct ASN,
so a typical path costs a couple of requests rather than four per hop.

---

## Privacy boundary

`src/integrations/index.mjs` is the only module that talks to third parties, and
it will only ever transmit:

- a **globally routable** IP address, and
- an ASN or ISO country code derived from one.

Never transmitted:

```text
RFC1918 / CGNAT / loopback / link-local addresses
local hostnames
MAC addresses and BSSIDs
Wi-Fi SSIDs
internal DNS names
VPN routes and route tables
local topology / neighbour tables
```

The check is `isPubliclyEnrichable()`, which reuses `classifyAddress()` from
`src/security/target.mjs`, the same classifier that guards public probe
targeting. A target that resolves to a private address is reported as
`enriched: false` with an explicit reason, and **no outbound request is made at
all**. Traceroute hops inside your own network are marked
`skipped-private` and never looked up.

Tests assert this directly: a stub `fetch` that throws on any call is installed,
and enrichment of private addresses must complete without contacting anything.

---

## Failure behaviour

Each integration:

- is bounded by an `AbortController` timeout (5–8 s depending on source),
- validates the response shape before use,
- returns a status envelope (`ok` / `unavailable` / `not-configured` / `skipped`)
  instead of throwing,
- is cached so a dashboard refresh does not re-measure.

**A third-party outage can never fail the local diagnostic.** The live panel
renders per-source status:

```text
RIPEstat     ok
Globalping   3/3 measurements complete
IODA         no current data
Radar        Not configured
```

---

## How to test a real public target

1. `npm start`
2. Open <http://localhost:3000>
3. Click **Unlock live data** and paste the admin token (printed at startup when
   `FAULTLINE_ADMIN_TOKEN` is unset).
4. In **Test a real target**, enter `example.com`, `1.1.1.1`, or
   `https://example.com/health`.
5. Press **Run live diagnostic**.

The live routes are admin-authenticated on purpose: they make real outbound
connections and spawn `ping`/`tracert`, so leaving them open would hand an SSRF
and resource-abuse primitive to anyone who can reach the control plane.

Accepted target forms:

```text
example.com
1.1.1.1
https://example.com
https://example.com/health
```

Public-scope targets are held to the existing public-probe safety rules:
private/reserved addresses are refused, only approved ports are allowed, and every
redirect hop is re-resolved and re-validated (so DNS rebinding cannot smuggle in a
private address mid-chain).

## How to load a private environment

**Load my environment → Insert example manifest → Preview manifest → Activate.**

Manifests are strict JSON:

```json
{
  "version": 1,
  "sites": [{ "id": "glasgow", "name": "Glasgow Office" }],
  "targets": [
    { "name": "Customer Portal", "url": "https://portal.example.com", "scope": "public", "contract": "secure-web" },
    { "name": "Internal CRM", "host": "crm.internal.example", "port": 443, "scope": "private", "site": "glasgow", "contract": "secure-web" }
  ]
}
```

Validation is allow-list based:

- unknown fields are **rejected**, not ignored;
- any credential-shaped field (`password`, `token`, `apiKey`, …) is rejected
  outright, so nobody can believe a secret was stored;
- a literal private address is **always** private, and declaring it `"scope":
  "public"` is an error;
- targets may not reference an undeclared site;
- bounded to 50 sites / 200 targets.

Preview shows exactly what would run before anything is activated.

## How to run a private probe

Private targets are never measured by a public probe. Register a private probe
and run it inside the network:

```bash
npm run probe:register -- --name glasgow-1 --scope private --location "Glasgow Office" \
  --api-base http://localhost:3000 --admin-token "$FAULTLINE_ADMIN_TOKEN"

npm run probe -- --probe PRB-XXXXXXXXXX --token fl_probe_... \
  --api-base http://localhost:3000 --watch
```

The worker polls outbound over authenticated HTTPS and pulls its own jobs, so **no
inbound firewall port is required**. Until an enabled private probe exists,
manifest activation reports private targets as `runnable: false` with an explicit
blocked reason.

---

## Attribution

- RIPEstat and RIPE Atlas data - © RIPE NCC
- IODA data - © Georgia Tech Research Corporation
- PeeringDB - © PeeringDB
- Globalping - © jsDelivr / Globalping contributors
- Cloudflare Radar - © Cloudflare

Faultline queries these services as a client. It does not redistribute bulk data,
and it caches responses to keep request volume low. Globalping measurements are
capped at 5 public vantages (default 3) per diagnostic.

---

## What this is not

- Not proof of fault ownership. IP ownership ≠ fault ownership.
- Not proof of path. PeeringDB exchange/facility records describe what a network
  publishes about itself, labelled **NETWORK METADATA**, never **OBSERVED PATH**.
- Not causation. A correlated IODA anomaly or BGP event is described as a
  "potentially relevant external signal".
- Not an AI/LLM feature. There is no model in this path, and no inference service
  is required to run Faultline.
