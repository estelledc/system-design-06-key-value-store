# Operations guide

## Configuration

| Environment variable | Default | Constraint |
|---|---|---|
| `HOST` | `127.0.0.1` | Keep loopback unless an authenticated proxy is added |
| `PORT` | `3000` | `0` selects an ephemeral port |
| `DATA_DIRECTORY` | `.data` | Dedicated writable directory with restricted ownership |
| `NODE_IDS` | `node-a,node-b,node-c` | Unique safe aliases |
| `COORDINATOR_ID` | `coordinator-a` | Stable writer identity for causal context |
| `REPLICA_COUNT` | `3` | At most physical node count |
| `READ_QUORUM` | `2` | At most replica count |
| `WRITE_QUORUM` | `2` | At most replica count |
| `LOG_HMAC_SECRET` | none | Required; at least 32 bytes |

Record the full placement fingerprint and quorum tuple at rollout. A changed fingerprint is a data-migration event, not a harmless restart.

Give each running process exclusive ownership of its data directory. The WAL is forced to owner read/write permissions, but the lab does not implement a cross-process file lock; two writers opening the same replica directory would violate the append-serialization assumption.

## Startup and shutdown

Startup opens and replays every replica WAL before binding the port. Any incomplete frame, checksum mismatch, invalid version, or conflicting operation identity aborts startup. Do not delete the failing line and continue: first preserve the file, compare verified replicas, and write a reviewed repair plan.

`SIGTERM` and `SIGINT` stop accepting connections and close the HTTP server. Each mutation opens, syncs, and closes its WAL descriptor before acknowledgement, so no persistent descriptor drain is needed. `SIGKILL` recovery is exercised by the runtime smoke.

## Signals and alert candidates

| Signal | Meaning | Alert candidate |
|---|---|---|
| `quorum_kv_quorum_failures_total` | Insufficient strict replicas | Any sustained increase outside a fault drill |
| `quorum_kv_conflicts_total` | Siblings or operation misuse | Growth without a reconciliation consumer |
| `quorum_kv_read_repairs_total` | Reachable replica lag | High rate or non-converging repeated repairs |
| Placement fingerprint by instance | Membership/config agreement | More than one intended fingerprint |
| WAL bytes and records by replica | Unbounded storage growth | Forecast reaches capacity/reserve threshold |
| Startup corruption failures | WAL cannot be trusted | Page immediately; preserve evidence |
| HTTP latency by operation/status | fsync, merge, or overload symptoms | SLO-specific; no default threshold claimed here |

The built-in metrics are process counters and reset on restart. A production host must scrape and retain them externally.

## Failure response

- `503` write with `partial: true`: the operation may be durable on fewer than `W` replicas. Retry the exact key, value/tombstone, context, and operation ID after recovery. Do not issue a new ID unless the business intends a new causal event.
- `503` read: return unavailable to the caller. Do not reinterpret it as key absence.
- `409 SIBLING_CONFLICT`: feed every sibling plus context to domain reconciliation. A generic last-write-wins merge is not supplied.
- `409 OPERATION_CONFLICT`: stop automated retry and investigate caller ID reuse; some replicas may already contain each branch.
- WAL corruption: quarantine the replica and restore from verified state. There is no automatic truncation.
- Fingerprint drift: block membership cutover, writes, and destructive cleanup until clients converge.

## Compaction and tombstone stop line

There is no safe “delete old WAL lines” command. Reclamation requires at least:

1. a checksummed snapshot with atomic publication and startup fallback;
2. proof that every retained replica has observed the causal tombstone or an explicit repair horizon;
3. a bounded operation-ID retention contract;
4. crash tests at every snapshot/rename/truncate boundary;
5. backup and restore receipts.

Until those exist, capacity exhaustion is safer than silently resurrecting or losing data. This is why the project remains a bounded lab.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
```

`npm run smoke` forces a process `SIGKILL`, restarts over the same data directory, verifies the acknowledged version and context, then performs a graceful shutdown. It does not cut power, corrupt a device cache, or move data across hosts.
