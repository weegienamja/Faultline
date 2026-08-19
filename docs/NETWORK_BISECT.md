# Network Bisect

`git bisect` finds the commit that broke a build. Network Bisect finds the
**network condition** that breaks a connection.

```bash
npm run bisect -- github.com
```

No server, no account, no API key, no external service. Every row of output is a
real connection made from your machine.

---

## The problem

When something "doesn't work on this network", the isolation procedure is
manual, disruptive and mostly guesswork:

```text
turn Wi-Fi off and on
try your phone hotspot
disconnect the VPN
change your DNS to 8.8.8.8
disable IPv6
try a different browser
try from another machine
```

Each step reconfigures the machine, often needs admin rights, interrupts
everything else, and gets undone before anyone writes down what happened. On a
managed endpoint most of them are not possible at all. And when one of them
appears to help, nobody re-tests to check the network did not simply recover on
its own.

## The idea

Nearly every one of those conditions can be varied **per connection** instead of
per machine:

| Support instruction | What Faultline varies instead | System change |
|---|---|---|
| "disable IPv6" | resolve and connect A-only or AAAA-only | none |
| "change your DNS" | send this lookup to a specific nameserver | none |
| "drop the VPN" | bind the socket to a different local source address | none |
| "try another server" | connect to each resolved answer individually | none |
| "it's a TLS problem" | pin the handshake to TLS 1.2 or 1.3 | none |
| "it's HTTP/2" | offer only h2 or only http/1.1 via ALPN | none |
| "it's the firewall" | send or omit SNI; try port 80 against 443 | none |

Nothing is reconfigured, nothing needs elevation, and other traffic is
undisturbed. Each variation is a controlled experiment.

## What it produces

```text
  CONDITION                     VARIANT                           RESULT n     DETAIL
  ----------------------------------------------------------------------------------
  baseline                      baseline (system defaults)        PASS  2/2   HTTP 200
  IP address family             IPv4 only                         PASS  2/2   HTTP 200
  IP address family             IPv6 only                         FAIL  0/2   tcp: ENETUNREACH
  DNS resolver                  resolver 1.1.1.1                  PASS  2/2   HTTP 200
  DNS resolver                  resolver 8.8.8.8                  PASS  2/2   HTTP 200
  Specific resolved address     address 2606:4700:10::6814:179a   FAIL  0/2   tcp: ENETUNREACH
  Local source interface        via Ethernet (192.168.0.95)       PASS  2/2   HTTP 200
  Local source interface        via Ethernet 2 (192.168.56.1)     FAIL  0/2   tcp: ENETUNREACH
  TLS version                   TLS 1.2 only                      PASS  2/2   HTTP 200
  TLS SNI                       no SNI                            FAIL  0/2   tls: handshake

  CONDITION ISOLATED
  IP address family: IPv6 only flips PASS to FAIL

  Evidence supports: the failure is reproducibly associated with
  ip address family = IPv6 only.

  Interleaved confirmation (A=baseline, B=IPv6 only): A+ B- A+ B-
  Difference held under alternation.
```

---

## Why this is not just running curl a few times

Four properties do the real work, and each exists because the naive version of
this tool would be wrong.

### 1. Reproducibility gating

An intermittent fault will make a single trial "prove" anything. Every
condition runs `--repeat` times and **only a unanimous result** counts as a
discriminator.

If the baseline itself is unstable, bisection is **refused**:

```text
  INTERMITTENT BASELINE
  Baseline is intermittent - bisection refused

  The target succeeded 2 of 4 times under unchanged conditions. Any condition
  would appear to "fix" it by chance, so no differentiating condition is reported.
```

Most tools would happily blame whichever variant happened to run during a good
patch. This one declines, and tells you the flake rate instead.

### 2. Interleaved paired confirmation

Running all of A and then all of B confounds the comparison with **time**. If
the network recovers halfway through, B looks like the cure.

The winning condition is therefore re-tested alternately:

```text
A+ B- A+ B-      difference held
A- B- A+ B+      network drifted; NOT confirmed
```

A drifting network produces a failed confirmation instead of a false
conclusion, reported as `UNCONFIRMED`.

### 3. Duplicate collapsing

Several axes can express the same physical change: `address-family=ipv4` and
`address=<the only A record>` produce an identical connection. Discriminators
are grouped by the **effective connection tuple** they produce
`(family, address, source, port, tlsVersion, alpn, sni)`, so one finding is
reported once and attributed to the most general axis that expresses it. The
equivalent forms are kept and listed, not silently dropped.

### 4. Honest classification

Not every difference is a fault:

- **`github.com` has no AAAA record.** Forcing IPv6 fails at DNS with `ENODATA`.
  That is a property of the target, so it is reported as
  `TARGET PROPERTY, NOT A LOCAL FAULT` — never as "your IPv6 is broken".
- **Omitting SNI breaks any name-based virtual host** by design. It is flagged
  as an *expected difference* and can never outrank a real finding.
- **ALPN is judged at the TLS handshake.** This client speaks HTTP/1.1; if it
  forced ALPN to `h2` and then sent an HTTP/1.1 request, the server's h2 preface
  would fail to parse and be misreported as a network fault. The useful question
  is whether the handshake can negotiate the protocol at all, which is exactly
  what a middlebox that mishandles h2 breaks.

---

## Usage

```bash
npm run bisect -- github.com
npm run bisect -- https://internal.example/health --repeat 5
npm run bisect -- 1.1.1.1 --no-source
npm run bisect -- example.com --json --out bisect.json
```

| Option | Meaning |
|---|---|
| `--repeat <n>` | Trials per condition, 1-10 (default 3). Raise it for intermittent faults. |
| `--confirm <n>` | Interleaved A/B pairs used to confirm the winner (default 3) |
| `--timeout <ms>` | Per-connection timeout (default 5000) |
| `--no-source` | Skip the source-interface axis |
| `--resolvers <csv>` | Comparison resolvers (default `1.1.1.1,8.8.8.8,9.9.9.9`) |
| `--json` / `--out <file>` | Machine-readable report |

### Exit codes

Usable in a script or a support runbook:

| Code | Meaning |
|---|---|
| `0` | No fault reproduced |
| `1` | A differentiating condition was isolated |
| `2` | Failure was not condition-specific |
| `3` | Evidence insufficient (intermittent baseline, or unconfirmed) |
| `4` | The run itself failed |

### In the dashboard

The **Network Bisect** panel runs the same engine through
`POST /api/bisect`. That route is admin-authenticated because a run makes many
real outbound connections; the CLI needs no credential at all.

---

## Verdicts

| Verdict | Meaning |
|---|---|
| `isolated` | One condition reproducibly flips the outcome and survived paired confirmation |
| `not-published` | The variant is unavailable because the target publishes no such record |
| `unconditional` | Every tested condition failed — the evidence points away from client-side path or protocol selection |
| `intermittent` | The baseline is unstable; bisection refused |
| `unstable` | A candidate appeared in the sweep but did not survive alternation |
| `healthy` | Nothing failed |

## What it does not claim

A confirmed discriminator establishes **association**, not causation. The
wording throughout is "evidence supports", never "this caused the fault".
Faultline reports that the failure tracks a condition; deciding why is still an
engineering judgement.

## Privacy

- No packet capture, no payloads, no browser history, no credentials.
- No subnet scanning: only the target you named is contacted.
- Local interface addresses are used to bind sockets and are never transmitted
  anywhere. Bisect makes no third-party API calls at all.

## Limits

- The source-interface axis binds IPv4 source addresses; an IPv4 source cannot
  be bound to an IPv6 connection and is reported as `inapplicable`.
- Binding a source address tests whether that interface can carry the
  connection. It does not override policy routing that ignores the source.
- The HTTP stage speaks HTTP/1.1; h2-specific behaviour beyond ALPN
  negotiation is out of scope.
- A wall-clock run of the full axis set is roughly `axes x variants x repeat`
  connections, so raise `--repeat` deliberately.
