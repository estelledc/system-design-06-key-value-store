# Threat model

## Assets and trust boundary

Assets are key/value confidentiality, acknowledged-version durability, operation identity, causal history, replica configuration integrity, and WAL integrity. The server accepts untrusted HTTP keys, JSON values, contexts, and operation IDs. Membership, quorum settings, filesystem, and log-HMAC secret are operator-controlled inputs.

This repository has no authentication, authorization, TLS, encryption at rest, tenant boundary, secret manager, or secure control plane. Loopback binding is a development guard, not an access-control system.

## Threats and mitigations

| Threat | Impact | Mitigation here | Remaining responsibility |
|---|---|---|---|
| Oversized/deep JSON | CPU, memory, or disk exhaustion | 16 KiB body, 10 KiB encoded value, depth 16 | Edge rate limit and total storage quotas |
| Clock cardinality attack | Large metadata and merge cost | 32 writer entries; safe IDs and counters | Authenticate writers and compact context under a proven protocol |
| Operation ID reuse | Ambiguous retry or lost update | Content-derived version; per-replica conflict detection; convergence check | Issue high-entropy IDs and never intentionally reuse them |
| Raw key/value logging | Sensitive data disclosure | HMAC key tag; values/contexts omitted from logs | Protect HMAC secret and operator endpoints; log retention policy |
| Offline key guessing | Recover a low-entropy key from an unkeyed digest | HMAC rather than plain hash | Rotate secret deliberately; use access control |
| WAL tampering/corruption | Wrong state after restart | Canonical checksum, version identity, fail-closed replay | Filesystem permissions, encryption/MAC, backup, replica repair |
| Unauthorized membership change | Reads/writes routed to attacker or wrong set | Placement fingerprint is observable | Signed config, authorization, coordinated activation |
| Topology disclosure | Infrastructure mapping | Node aliases only; public mutation errors return counts | Keep readiness on trusted operator plane |
| Disk exhaustion | Write outage or host failure | No hidden auto-compaction; WAL count metric in readiness | Capacity limit, snapshots, compaction, alerts, reserve space |
| Symlink/path manipulation | WAL written outside intended area | Node IDs cannot contain separators | Protect data-directory ownership; hardened deployment sandbox |

## Integrity boundary

The WAL checksum is accidental-corruption detection, not an authenticated MAC. An attacker who can modify the WAL can recompute it. Likewise, SHA-256 version IDs establish content identity but not caller authorization. Production integrity needs OS isolation, authenticated configuration, encryption/MAC key management, and replicated backup.

## Availability boundary

Strict quorum intentionally returns `503` during some partitions. There is no retry loop inside the server because an automatic changed operation or context could create new versions. Callers may retry only the identical mutation under a bounded policy. Request admission control, timeouts, socket-level partitions, and overload protection remain outside this lab.
