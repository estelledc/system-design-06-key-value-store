# Verification record

## Gate

`npm run check` executes:

1. syntax, portable-path, local-link, secret-pattern, skipped-test, required-artifact, and pinned-Action checks;
2. every Node test with the spec reporter;
3. a child-process crash/restart smoke using real WAL files and HTTP;
4. an environment-bound durable-write/read benchmark;
5. `npm audit --audit-level=high` over the lockfile.

## Tested behaviors

- canonical JSON and bounded input;
- vector-clock order, concurrent siblings, conservative equal-clock events, merge resolution, and identity tampering;
- deterministic rendezvous placement and sampled add-node movement;
- fsync-before-apply, idempotent retry, serialized concurrent WAL appends, replay, truncation, and checksum corruption;
- completed and partial writes, read quorum failure, read repair, causal tombstone, and operation conflict;
- two coordinators preserving and resolving concurrent branches;
- a concrete stale-read counterexample under different placement fingerprints despite `N=3, W=2, R=2` on both sides;
- HTTP lifecycle, `409` sibling flow, delete context, input errors, HMAC-safe logs, health, and metrics;
- process `SIGKILL`, same-directory restart, recovered value/context, and graceful second shutdown.

No test is skipped. CI runs the same locked gate on Node 22, 24, and 26.

## Current receipts

The initial public CI receipt is pending repository publication. Replace this sentence only after the GitHub run is green.

## Evidence boundary

Passing the gate supports the listed single-process protocol, WAL, HTTP, and crash-replay claims in the tested environment. It does not establish:

- linearizability, serializability, consensus, or safe membership reconfiguration;
- sloppy quorum, hinted handoff, Merkle repair, anti-entropy convergence, or multi-region behavior;
- sudden-power-loss or storage-device durability;
- safe snapshot, compaction, tombstone collection, backup, or restore;
- independent host failures, real packet loss/latency, production load, deployment, security review, SLA, or external acceptance.

## Reproduce locally

```sh
npm ci --ignore-scripts
npm run check
```

Benchmark timings are printed with Node, OS, architecture, operation counts, quorum settings, WAL record count, and checksum. They are run receipts, not a throughput forecast.
