# Changelog

## [0.1.2] - 2026-11-23

- A phone page hidden for a few seconds (BYE on hide, the room `away`) is seen again at once when it is shown. The
  others drop its cursor after `leaveHoldMs`. But a page hidden for less than the mesh's 20 s dead window keeps its
  links, so its own room reports no peer going down or coming up, and 0.1.1's resend on a peer coming up never ran.
  The cursor came back at its next change or at y-protocols' 15 s renewal: 11.6 s in a published example
  (jsflow-demos DR3 part 3). On `connected` after `away`, the provider now sends its state to every peer again.

## [0.1.1] - 2026-11-23

- A peer back after its `leaveHoldMs` ran out (a phone page hidden longer than that, a dropped link) is seen again
  at once. Its awareness clock is forgotten with its entries: y-protocols keeps a removed client's clock and takes
  only a higher one, so its resent state was ignored until its next change, up to 15 s on an idle page (jsflow-demos
  DR3).
- A page back as a new peer within `leaveHoldMs` (offline and back, the same `Awareness`) keeps its cursor: the old
  peer's hold running out no longer removes it.
- The README: to reconnect, give the new provider the same `Awareness`.

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
