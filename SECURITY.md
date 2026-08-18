# Security policy

## Supported version

Only the current `main` branch is maintained. This repository is a protocol and durability study, not a hosted database service.

## Reporting

Use GitHub's private security-advisory flow. Do not attach production keys, values, membership lists, credentials, or WAL files to a public issue.

## Scope boundary

The HTTP process binds to loopback by default and requires a log-HMAC secret, but it does not implement client authentication, TLS, authorization, encryption at rest, multi-tenant isolation, backup, or a secure control plane. Do not expose it to an untrusted network. See [Threat model](docs/threat-model.md).
