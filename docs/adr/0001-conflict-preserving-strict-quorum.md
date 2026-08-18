# ADR 0001: Preserve causal conflicts on a strict quorum

- Status: accepted
- Date: 2026-08-18

## Context

The exercise must expose what quorum numbers do and do not guarantee. A broad “highly available, strongly consistent key-value store” would mix incompatible contracts. The minimal useful vertical slice needs durable writes, read/write failures, concurrent updates, retry ambiguity, and a configuration-drift counterexample.

## Decision

Implement a Dynamo-inspired causal version API over one fixed rendezvous preference list, but use strict quorum membership rather than sloppy quorum. Store every acknowledged version in a checksummed append-only WAL before changing memory. Return non-dominated siblings and require application reconciliation. Use `N=3, W=2, R=2` by default and expose the placement fingerprint with every operator configuration.

The coordinator waits for all immediately reachable preferred replicas in v0.1 and then evaluates the threshold. This favors deterministic evidence over optimized tail latency.

## Alternatives considered

### Last-write-wins by wall clock

It produces a single value but can silently lose a concurrent acknowledged update and relies on clock semantics that the lab does not provide. Rejected for the core contract.

### Leader or consensus-replicated log

A leader with consensus can provide a total order and support linearizable operations under its stated failure model. That would be the right design for a different requirement. It would obscure the intended quorum/eventual-consistency lesson and require elections, terms, log matching, reconfiguration, and durable consensus metadata.

### ABD-style atomic register

Attiya–Bar-Noy–Dolev shows that quorum messaging plus a specific timestamped protocol and majority assumptions can emulate an atomic register. Implementing that protocol would be stronger than this API, but it is not equivalent to adding `R + W > N` to a Dynamo-style store. It remains a future alternative, not an implied property.

### Sloppy quorum and hinted handoff

They improve availability by writing to healthy fallback nodes, but the acknowledged set may no longer intersect a later strict read set until hints are delivered. Correct implementation needs hint durability, target identity, delivery idempotency, expiry, overload policy, and repair evidence. Deferred rather than represented by a fake fallback.

### Full LSM storage engine

Commit logs, memtables, SSTables, Bloom filters, compaction, and tombstone collection are important local-engine mechanics. They are orthogonal to the first distributed-protocol slice and would multiply recovery states. The v0.1 WAL deliberately grows without bound so this limitation cannot be missed.

## Consequences

- Completed, partial, conflicting, and repaired states are directly testable.
- Applications must handle `409` siblings and retain read context.
- Network partitions reduce availability because fallback nodes are not used.
- `R/W/N` remain tunable, but they are not marketed as a consistency level by themselves.
- The single process cannot prove host independence or real network behavior.
- Unbounded WAL growth prevents production use until snapshot, compaction, backup, and tombstone safety are designed and tested.

## References

- [Amazon Dynamo](https://www.allthingsdistributed.com/2007/10/amazons_dynamo.html)
- [Sharing Memory Robustly in Message-Passing Systems](https://research.ibm.com/publications/sharing-memory-robustly-in-message-passing-systems)
- [CAP proof](https://sites.cs.ucsb.edu/~rich/class/cs293b-cloud/papers/cap-proof.pdf)
