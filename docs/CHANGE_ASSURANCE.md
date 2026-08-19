# Network Change Assurance

Faultline v1.5 turns repeated diagnostics into an explicit **before/after network change workflow**.

The purpose is not to claim that every observed difference was caused by the change. The purpose is to preserve a controlled baseline, repeat the same diagnostic after the change, and state exactly which measured behaviours changed.

## Workflow

```text
Create support case
      |
Create named change window
      |
Run pre-change diagnostic
      |
Select baseline session
      |
Make firewall/VPN/DNS/SD-WAN/proxy/etc. change
      |
Run post-change diagnostic
      |
Select post-change session
      |
Faultline compares evidence
      |
Export assurance package
```

## API

Create/list change windows:

```text
POST /api/cases/:caseId/change-windows
GET  /api/cases/:caseId/change-windows
```

Select the baseline and post-change diagnostics:

```text
POST /api/cases/:caseId/change-windows/:changeId/baseline
POST /api/cases/:caseId/change-windows/:changeId/post-change
```

Both accept:

```json
{ "sessionId": "FL-..." }
```

Read the result:

```text
GET /api/cases/:caseId/change-windows/:changeId/comparison
GET /api/cases/:caseId/change-windows/:changeId/evidence
```

The JavaScript SDK exposes equivalent helper methods.

## Comparison dimensions

### Connectivity Contract

Where per-check results are available, Faultline compares each required check and identifies true→false regressions and false→true improvements.

### Protocol/network states

Explicit state transitions include:

- IPv4 reachability;
- IPv6 reachability;
- TLS handshake success;
- overall Connectivity Contract pass/fail.

### Numerical evidence

The first preview compares:

- gateway loss/latency;
- upstream loss;
- jitter;
- DNS timing;
- TCP/HTTP timing;
- contract pass rate / failed-required count;
- TLS handshake time;
- HTTP TTFB;
- path MTU.

A worsening measurement is labelled a **regression candidate**, not proof that the infrastructure change caused it.

### Path and topology

The comparison records whether the observed traceroute IP sequence or inferred local topology signature changed. These are evidence differences, not ownership proof.

## Result

A comparison has an outcome of:

```text
regression-detected
no-regression-detected
```

and separate `regressions` / `improvements` collections. The change-assurance evidence package includes a SHA-256 digest over the canonical package contents.

## Audit

The case audit stream records:

- change window creation;
- baseline selection;
- completed before/after comparison and regression count.

## Suitable demonstrations

- firewall policy or allow-list change;
- VPN/split-tunnel modification;
- DNS resolver migration;
- SD-WAN policy change;
- proxy/security gateway rollout;
- ISP circuit/path change;
- SaaS connectivity requirement change.

## Limits

- the current comparison uses explicitly selected runs rather than scheduling change windows automatically;
- regression classification is deterministic and deliberately simple, not statistically calibrated causation;
- route changes can occur naturally and do not prove a routing fault;
- topology is still endpoint-inferred unless an authoritative controller source is added in a later roadmap stage;
- v1.4 deep fields appear in change comparisons only when the selected diagnostic runs actually contain them.
