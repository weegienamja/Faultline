# Network Bisect — adaptive fault isolation

`git bisect` finds the commit that broke a build. Network Bisect finds the
**network condition** that changes whether a target works — and it chooses which
experiment to run next rather than sweeping every test.

```bash
npm run bisect -- github.com
```

No server, no account, no API key, no third-party call. Every line of output is a
real connection made from your machine.

---

## What it does differently

A sweep runs everything and lets you read the table. This engine behaves more
like an engineer conducting controlled experiments:

```text
1  establish what kind of baseline this is
2  form explicit competing explanations
3  choose the experiment that best separates them
4  observe
5  eliminate the explanations that no longer fit
6  choose again
7  stop when the evidence has isolated a boundary
```

Every step is recorded, so a run reads as reasoning rather than as output:

```text
  Baseline
  FAIL 3/3 — ECONNREFUSED

  Baseline fails consistently. Isolating which condition changes that.

  [1] IP address family: IPv4 only
      Highest discrimination score (6.6). Separates 10 live explanations into
      3 predicted outcomes (3/3/4).
      PASS 3/3 — HTTP 200

  Confirming (interleaved A/B; A = baseline)
      A- B+ A- B+ A- B+   held under alternation

  FAILURE CONDITION ISOLATED
  IP address family: IPv4 only changes FAIL to PASS

  Evidence supports a fault specific to ip address family. Changing only that
  condition reproducibly restores the connection.

  Experiments: 1 executed, 1 skipped as low-value, 0 inapplicable.
  12 real connection attempts. Stopping reason: ISOLATED.
```

One experiment. Twelve connections. The sweep needs 33 for the same target.

---

## Result states

Two-state pass/fail is not enough. These are first class and never collapsed:

| State | Meaning |
|---|---|
| `PASS` | the connection completed under this condition |
| `FAIL` | it did not complete, and it could have |
| `INAPPLICABLE` | the condition cannot be applied to this target/machine pair |
| `UNSUPPORTED` | the machine cannot perform the experiment at all |
| `UNSTABLE` | repeated trials disagreed |

`INAPPLICABLE` and `UNSUPPORTED` are statements about the *experiment*, not about
the network. Only `PASS` and `FAIL` are evidence about connectivity, and only
those ever move a hypothesis.

This is what fixes a concrete bug in the previous version: a VirtualBox
host-only adapter is "Up" and has an address, but owns no route to the Internet.
Binding to it produced `ENETUNREACH`, which was scored `FAIL` and reported
alongside genuine findings. It is now `INAPPLICABLE`, decided from routing data.

## Baseline states

The engine interprets a healthy baseline completely differently from a failing one.

| Baseline | What the run becomes |
|---|---|
| `FAILED_BASELINE` | true fault isolation — look for `FAIL → PASS` |
| `HEALTHY_BASELINE` | differential capability analysis — nothing is broken |
| `INTERMITTENT_BASELINE` | isolation **refused**, flake rate reported |

A healthy baseline never produces a "fault". `github.com` not answering over
IPv6 is reported as a target property, not as something wrong with your network.

## Conclusions

| Classification | Meaning |
|---|---|
| `FAILURE_DISCRIMINATOR` | a condition reproducibly repairs a failing baseline |
| `LOCAL_CAPABILITY_DEFICIENCY` | the target offers it; this machine cannot use it |
| `TARGET_PROPERTY` | the target does not offer it at all |
| `NO_MEANINGFUL_DIFFERENCE` | nothing changed the outcome |
| `UNSTABLE_BASELINE` | the baseline could not be reproduced |
| `INSUFFICIENT_EVIDENCE` | observations conflict, or explanations cannot be separated |
| `INAPPLICABLE_CONDITION` | no experiment applied |

---

## The experiment-selection algorithm

For a candidate experiment, every live hypothesis states what it expects.
That partitions the live set by predicted outcome. If they all predict the same
thing, the experiment cannot change what is believed, and it scores zero.

Otherwise the score uses the **expected size of the surviving hypothesis set** —
the standard "expected remaining candidates" measure from decision-tree and
Mastermind-style solvers:

```text
expectedRemaining = Σ over groups g:  (|g| / N) · |g|
discrimination    = N − expectedRemaining
score             = discrimination / cost
```

Reading it plainly: if the experiment produces the outcome group *g* predicted,
roughly the members of *g* survive; the chance of landing in *g* is taken as
`|g|/N` because that many live hypotheses expect it. Lower remaining is better.

Worked examples with **N = 6**:

| Split | expectedRemaining | discrimination |
|---|---|---|
| 3 / 3 | `(3/6)·3 + (3/6)·3` = **3.00** | **3.00** |
| 2 / 4 | `(2/6)·2 + (4/6)·4` = **3.33** | 2.67 |
| 1 / 5 | `(1/6)·1 + (5/6)·5` = **4.33** | 1.67 |
| 6 / 0 | `(6/6)·6` = **6.00** | 0.00 |

So a balanced 3/3 split outranks a lopsided 1/5 at equal cost — the property a
bisection strategy needs. Hypotheses answering `UNKNOWN` make no commitment and
are excluded from the partition rather than lumped into a group they never
claimed.

Ties break deterministically: lower cost, then lower intrusiveness, then registry
order, then id. **The same evidence always produces the same plan** — there is a
test for it.

### Predictions

A hypothesis about an axis it owns predicts `DIFFERS` ("some variant of this axis
changes the outcome") rather than committing to which one. Observing "same as
baseline" then *weakens* it rather than contradicting it, because another variant
of that axis may still be the one that differs.

### Pruning

An experiment is dropped before scoring, with a recorded reason, when:

- its axis already has a confirmed discriminator,
- an equivalent experiment already produced the same connection,
- it is known-inapplicable (no route from that source),
- it differs by design rather than by fault (SNI on a name-based host),
- or no live hypothesis disagrees about it.

`SKIPPED` is always explainable and is never confused with `UNSUPPORTED`.

## Stopping rules

| Reason | Fires when |
|---|---|
| `ISOLATED` | a boundary was reproducibly identified and confirmed |
| `TARGET_PROPERTY` | the difference comes from what the target offers |
| `NO_DISCRIMINATOR` | every applicable experiment behaved identically |
| `UNSTABLE` | the baseline could not be reproduced |
| `INSUFFICIENT_EVIDENCE` | a candidate failed confirmation, or explanations remain |
| `UNSUPPORTED` | the machine cannot run the necessary experiments |

The engine does not keep connecting merely because tests exist.

---

## Interface classification

Source-interface experiments need to know whether an interface can plausibly
reach the target. That is decided from routing, not adapter names:

```text
Ethernet     192.168.0.95   PRIMARY
Ethernet 2   192.168.56.1   HOST_ONLY    NO TARGET ROUTE
```

On Windows, `Find-NetRoute` performs the OS's own route selection for the
destination; if it does not select this interface, the interface has no route and
the experiment is `INAPPLICABLE`. Owning the lowest-metric default route makes an
interface `PRIMARY` regardless of what it is called.

Classifications: `PRIMARY`, `ETHERNET`, `WIFI`, `VPN`, `VIRTUAL`, `HOST_ONLY`,
`LOOPBACK`, `UNKNOWN`. A vendor is never asserted from a description string
alone — "host-only" is used because the OS also reports no default route through
it. On non-Windows hosts route state is `UNKNOWN`, which the planner treats as
"cannot decide" rather than "no route".

---

## Interleaved paired confirmation

Running all of A then all of B confounds the comparison with time: if the network
recovers halfway through, B looks like the cure. Any candidate is re-tested
alternately:

```text
A- B+ A- B+ A- B+     difference held
A- B- A+ B+           network drifted; NOT confirmed
```

Drift produces `INSUFFICIENT_EVIDENCE`, not a false conclusion.

---

## Usage

```bash
npm run bisect -- github.com                      # adaptive (default)
npm run bisect -- github.com --all                # full condition matrix
npm run bisect -- https://internal.example/health --repeat 5
npm run bisect -- example.com --json --out bisect.json
```

| Option | Meaning |
|---|---|
| `--all` | complete condition matrix instead of adaptive planning |
| `--repeat <n>` | trials per condition, 1-10 (default 3) |
| `--confirm <n>` | interleaved A/B pairs (default 3) |
| `--timeout <ms>` | per-connection timeout (default 5000) |
| `--max <n>` | maximum experiments in adaptive mode (default 12) |
| `--no-source` | skip the source-interface axis |
| `--resolvers <csv>` | comparison resolvers |
| `--json` / `--out <file>` | machine-readable report |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | no fault reproduced / target property / no meaningful difference |
| `1` | a condition was isolated |
| `2` | failure was not specific to any tested condition |
| `3` | evidence insufficient (intermittent, or unconfirmed) |
| `4` | the run could not be performed |

### Two modes

**Adaptive** is fast diagnosis: it stops when the evidence is sufficient.
**`--all`** is a full capability audit: it runs every condition regardless, which
is what you want when documenting what a target supports rather than chasing a
fault.

---

## Adding a new axis

The planner never sees how a condition is applied. An axis registers:

```js
{
  id, label, rationale, cost, intrusiveness,
  stopAt,                        // stage that decides the verdict, if not the whole stack
  applicability(context),        // { applicable, variants } or { applicable: false, reason }
  expectedDifference             // differs by design rather than by fault
}
```

Packet size / DF bit, proxy, gateway selection and MTU threshold can be added
this way without changing the planner or the hypothesis engine.

## What it does not claim

A confirmed discriminator establishes **association**, not causation. The wording
is "evidence supports", never "this caused the fault". No probabilities, no
confidence percentages, no model.

## Privacy

No packet capture, no payloads, no browser history, no credentials, no subnet
scanning. Local interface addresses are used to bind sockets and are never
transmitted. Bisect makes no third-party API calls at all.

## Limits

- Source-interface binding is IPv4; route lookup is Windows-only, and other
  platforms report `UNKNOWN` rather than guessing.
- Binding a source tests whether that interface can carry the connection; it does
  not override policy routing that ignores the source.
- The HTTP stage speaks HTTP/1.1, so h2 behaviour beyond ALPN negotiation is out
  of scope.
- MTU/DF is not yet an axis; the registry is shaped to accept it.
