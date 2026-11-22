# Changelog

## [0.1.0] - 2026-11-22

The first release.

- `JsflowProvider(room, doc, options)` syncs a `Y.Doc` and a y-protocols `Awareness` over a joined jsflow room
  (jsflow-sdk 1.0 or later; `path()` from 1.1 is used when present), on one app channel (default 13).
- Small edits are broadcast; larger ones go reliably to each peer, in parts above 64 KB.
- A joiner asks one peer for the document, direct before relay before mesh, and the next after `syncTimeoutMs`.
  State vectors go both ways when two peers meet.
- Repair: an update with a missing predecessor asks its sender at once; a periodic exchange with one random peer
  (`resyncMs`).
- Each peer sends only its own awareness state; an unreachable peer's is removed after `leaveHoldMs`, and
  `destroy()` removes your own at once.
- `yjs` and `y-protocols` are peer dependencies; no dependencies of its own.
- A large document arrives in parts, and the wait for an answer restarts with each part; a peer that answers and
  then becomes unreachable is asked again, and one unreachable for a moment keeps what it was sending and receiving
  for `leaveHoldMs`. Measured with 2 peers in Chrome: 5 MB in about 2 s over a direct connection, 13 s through a
  relay, 10 MB in 27 s through a relay. Large documents through a relay need jsflow-sdk 1.1.1 or later.
