# Packaged Windows client

The v0.6 Windows client preview turns the existing endpoint collector into a standalone `Faultline.exe` so the affected user does not need Node.js, npm, Git or a Faultline checkout.

## Packaging

The client is built with Node.js Single Executable Application support.

Configuration:

```text
build/windows/sea-config.json
```

Build command on Node.js 26+:

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
node --build-sea build/windows/sea-config.json
```

Output:

```text
dist/Faultline.exe
```

The SEA entry point is intentionally one standalone ECMAScript module using only Node built-ins. Filesystem module loading is not required at runtime.

`execArgvExtension` is set to `none`, preventing `NODE_OPTIONS` or user CLI Node flags from extending the embedded runtime configuration.

## CI

The GitHub Actions Windows job:

1. checks out the repository on `windows-latest`
2. installs Node.js 26
3. builds `dist/Faultline.exe`
4. runs `Faultline.exe --self-test`
5. uploads the executable as the `faultline-windows-client` workflow artifact

The self-test exercises the embedded ping parser and topology builder from the actual generated executable.

## Handoff discovery

The executable accepts an explicit `.faultline` path:

```powershell
.\Faultline.exe .\Faultline-FL-ABC.faultline
```

When launched with no path, it searches for the newest matching handoff in:

- the current working directory
- the directory containing `Faultline.exe`
- the current user's Downloads directory

A valid handoff contains:

```json
{
  "version": 1,
  "sessionId": "FL-...",
  "apiBase": "https://faultline.example.com",
  "launchToken": "fl_launch_...",
  "createdAt": "..."
}
```

The launcher token is not the endpoint upload credential. It can only be exchanged once.

## Runtime flow

```text
Load .faultline handoff
        |
        v
POST /api/client/exchange
        |
        v
Receive session + endpoint credential
        |
        v
Delete handoff where possible
        |
        v
Read Windows network state
        |
        +-- default route
        +-- active adapter
        +-- local IPv4
        +-- VPN adapters
        +-- route table
        +-- passive neighbour table
        +-- Wi-Fi SSID/BSSID/signal/channel
        |
        v
Run gateway/DNS/internet/target/path tests
        |
        v
Build optional inferred topology
        |
        v
POST /api/agent-runs
        |
        v
Show diagnostic reference + current fault domain
```

## Collected evidence

The packaged client currently collects the same main evidence classes as the Node endpoint collector:

- default-gateway RTT/loss
- Wi-Fi state and signal when available
- DNS resolution timing
- general internet TCP reachability
- target ICMP observations
- target TCP connection timing
- HTTP timing for HTTP/HTTPS targets
- traceroute observations
- active routes and VPN-adapter state
- passive local neighbour-table entries
- best-effort inferred topology when consented

It does not capture packet payload contents.

## Failure behaviour

The client retries evidence upload three times.

If upload still fails, it writes a token-free diagnostic payload beside the handoff location:

```text
Faultline-FL-...-results.json
```

The recovery file contains collected evidence but does not contain the invitation, launcher or endpoint bearer token.

Because the launcher is already consumed at this point, automated later upload of that recovery file is not yet implemented. A new support invitation may be required.

## Distribution

The control plane reads:

```text
FAULTLINE_WINDOWS_CLIENT_URL
```

When configured, the consent page presents that URL as the `Faultline.exe` download.

When it is not configured, the handoff is still generated but the page tells the user that the support engineer must provide the executable separately.

The current CI artifact is unsigned. A production distribution pipeline should add:

- Authenticode code signing
- a stable HTTPS download origin
- checksums / release metadata
- retained signed release versions
- an update/revocation policy

## Current limitations

- Windows only
- console UI rather than a native graphical shell
- unsigned preview binary
- passive topology discovery only
- no custom `faultline://` URI handler yet
- no installer or file association
- no automatic recovery upload after a failed final upload
- broader testing is needed across enterprise endpoint controls and VPN clients

The immediate goal is not a permanent endpoint agent. `Faultline.exe` remains an incident-triggered, one-session diagnostic client.
