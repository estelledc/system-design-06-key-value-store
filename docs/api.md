# HTTP API

The server binds to `127.0.0.1` by default. It has no client authentication or TLS and must not be exposed directly to an untrusted network.

## Write a version

`PUT /v1/kv/{percent-encoded-key}`

Required header:

```text
Idempotency-Key: 1-128 safe identifier characters
```

Body:

```json
{
  "value": { "items": ["book"] },
  "context": {}
}
```

`context` is optional for the first write. For an update, pass the exact context returned by the preceding read. A successful response contains the new context, deterministic version ID, and quorum counts.

An identical retry with the same key, operation ID, context, and value returns the same version ID. Reusing the ID for different content returns `409 OPERATION_CONFLICT` when detected. During a partition, two disjoint replicas might not detect misuse immediately; convergence fails closed when the divergent identities meet.

## Read versions

`GET /v1/kv/{percent-encoded-key}`

- `200`: one live causal leaf, returned as `version` with `context`.
- `404 KEY_NOT_FOUND`: no version or one tombstone leaf. The response still includes context so callers do not resurrect deleted state with a context-free write.
- `409 SIBLING_CONFLICT`: more than one non-dominated leaf. The response includes `siblings` and their merged `context`; the application chooses a semantic merge and sends a new `PUT` with that context.
- `503 QUORUM_UNAVAILABLE`: fewer than `R` preferred replicas responded. No value is fabricated.

The coordinator waits for every immediately reachable preferred replica in this lab, then checks the quorum threshold. It does not implement production timeout, hedging, cancellation, or tail-latency optimization.

## Delete

`DELETE /v1/kv/{percent-encoded-key}` with an `Idempotency-Key` header and optional body:

```json
{ "context": { "coordinator-a": 2 } }
```

Delete writes a replicated tombstone. It does not physically remove the key or WAL history. Context-free delete can conflict with a concurrent value; this is intentional.

## Health and metrics

- `GET /health/live`: process can answer HTTP.
- `GET /health/ready`: current placement/quorum config and local replica replay state.
- `GET /metrics`: Prometheus text counters for requests, errors, quorum failures, conflicts, and applied read repairs.

Readiness exposes node aliases and is intended for a trusted operator plane. Logs contain an HMAC-derived key tag, never the raw key. Values and contexts are not logged.

## Input and error boundary

- Key: 1–512 UTF-8 bytes, no control characters.
- Encoded JSON value: at most 10 KiB and 16 nesting levels.
- HTTP body: at most 16 KiB.
- Context: at most 32 safe writer IDs with positive safe-integer counters.
- Node, coordinator, and operation IDs: 1–128 ASCII letters, digits, `.`, `_`, or `-`, beginning with an alphanumeric character.

Validation errors are `400`; unsupported media type is `415`; oversized body is `413`; unknown path is `404`; unsupported method is `405`. Unexpected internal details are not returned to the client.
