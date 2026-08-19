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

- Implementation commit: `55d002cc7a135dfffbb7ceaeb3892fde719fee01` (identity-safe rewrite of `e9af3381287fdf8e041a7be3956ef189a4ff85ca`).
- Historical public CI before the author-metadata rewrite: [run 32150216536](https://github.com/estelledc/system-design-06-key-value-store/actions/runs/32150216536). Its tested tree is identical to the rewritten implementation commit, but the run remains bound to the old commit object.
- Node 22.23.2, 24.19.0, and 26.7.0 each reported 29 passed, 0 failed, 0 skipped, and 0 high-or-greater npm vulnerabilities.
- All three jobs wrote one version to three synced replica WALs, killed the process with `SIGKILL`, restarted over the same data directory, and recovered version `980863fdf8c69d1d9e0e6b07371448d159df89344a5d2fc9b4778b2df6302e38` with context `{"coordinator-a":1}`. The restart then shut down gracefully and neither process log contained the raw fixture key.
- Local full gates passed on Node 22.23.1 and 26.6.0. Local benchmark timings are environment evidence only; they are not copied into a capacity claim.

## Identity-safe main receipt

- Reachable `main` history was rewritten to use the repository owner's GitHub noreply identity. Every existing tree, commit message, author date, and committer date was preserved; only author and committer identity metadata changed.
- Rewritten baseline: `391216569bec01aab648b8dd789dc37c5dd248e9`.
- Public CI: [run 32223849000](https://github.com/estelledc/system-design-06-key-value-store/actions/runs/32223849000), successful on Node 22, 24, and 26 with the full quality gate.

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
