# Security Policy

## Supported versions

Faultline is currently developed from the `main` branch. Security fixes are applied to the current codebase rather than maintained across a set of long-lived release branches.

| Version | Supported |
| --- | --- |
| Current `main` | Yes |
| Older snapshots, forks, and abandoned branches | No |

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, pull request, discussion, or commit.

If GitHub's private vulnerability reporting option is available for this repository, use **Security → Report a vulnerability**. This is the preferred reporting route because it keeps the report private while allowing remediation to be coordinated in the repository.

If private vulnerability reporting is not available, open a minimal public issue that contains **no exploit details, secrets, customer information, target addresses, credentials, or proof-of-concept payloads** and ask the project owner to establish a private reporting channel.

A useful private report should include, where possible:

- the affected component and commit or version;
- the security impact;
- clear reproduction steps;
- any prerequisites or assumptions;
- a proof of concept that does not expose third-party systems or data;
- suggested remediation, if known.

## Security-sensitive areas

Reports are particularly useful for issues involving:

- authentication or authorization bypass;
- exposure of admin tokens, service credentials, or case-room credentials;
- SSRF or unsafe target validation;
- command execution or shell injection;
- path traversal or unsafe file handling;
- leakage of private network identifiers or customer information;
- cross-tenant or cross-case data exposure;
- unsafe handling of diagnostic evidence, capsules, or imported manifests;
- weaknesses that allow simulated or untrusted data to be represented as trusted measurement;
- dependency vulnerabilities that are actually reachable in Faultline's runtime.

## Safe testing

Only test against systems and networks you own or are explicitly authorized to assess. Do not use Faultline security research as a reason to probe third-party infrastructure without permission.

When sharing logs, screenshots, fixtures, packet-derived information, or diagnostic output, redact credentials and any private or customer-specific information that is not required to reproduce the issue.

## Response expectations

The project owner will aim to acknowledge a valid private report promptly, assess severity and reproducibility, and coordinate a fix before public disclosure where practical. Timelines will vary with the complexity and impact of the issue.

Security reports made in good faith and within the scope above are welcome.
