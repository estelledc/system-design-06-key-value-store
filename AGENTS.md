# Quorum KV contributor guide

- Preserve acknowledged-write, conflict-preservation, idempotent-retry, and WAL-replay invariants.
- Do not describe `R + W > N` as sufficient for linearizability.
- Treat a failed write as potentially partially durable and return that ambiguity explicitly.
- Do not discard concurrent siblings or tombstones with a wall-clock last-write-wins shortcut.
- Keep fault injection outside the public HTTP surface.
- Add executable failure or recovery evidence for every consistency claim.
- Do not copy prose, figures, or code from unlicensed system-design notes.
- Run `npm run check` before handoff.
