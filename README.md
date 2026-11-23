# y-jsflow

A [Yjs](https://yjs.dev) provider for [jsflow](https://jsflow.com). It syncs a `Y.Doc` and its awareness (cursors,
names, selections) between the peers in a jsflow room, peer to peer. No document server is involved.

```sh
npm install y-jsflow yjs y-protocols jsflow-sdk
```

```js
import * as Y from 'yjs';
import { join } from 'jsflow-sdk';
import { JsflowProvider } from 'y-jsflow';

const room = await join({ app: 'pk_…', room: 'doc-42' });
const doc = new Y.Doc();
const provider = new JsflowProvider(room, doc);
provider.awareness.setLocalStateField('user', { name: 'Ada', color: '#36c' });
provider.on('synced', () => console.log('up to date'));

// when the page is done with the document:
provider.destroy();
room.leave();
```

Any Yjs editor binding works with `provider.awareness`. For example, CodeMirror 6 with
[y-codemirror.next](https://github.com/yjs/y-codemirror.next):

```js
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { yCollab } from 'y-codemirror.next';

const ytext = doc.getText('codemirror');
new EditorView({
  state: EditorState.create({ doc: ytext.toString(), extensions: [yCollab(ytext, provider.awareness)] }),
  parent: document.querySelector('#editor'),
});
```

## API

### `new JsflowProvider(room, doc, options?)`

- `room`: a joined jsflow room (`await join(…)`). You keep control of the join: keys, tickets, region and
  `iceTransportPolicy` stay yours, and so does `room.leave()`.
- `doc`: the `Y.Doc` to sync. Use one provider per document. For two documents, use two rooms, or two
  providers on different channels.

| option | default | |
|---|---|---|
| `channel` | `13` | The app channel (0–13) the provider uses for everything. Keep your own messages on other channels. |
| `awareness` | a new one | An existing y-protocols `Awareness` for this document. One the provider creates is destroyed with it. To reconnect (`destroy()`, `room.leave()`, a new `join()` and provider), give the new provider the same `Awareness`: a new one starts its clock at 0, and the others ignore it until it passes the old one. |
| `resyncMs` | `15000` | How often each peer compares state with one random peer (±20 %), to repair updates lost on the way. |
| `leaveHoldMs` | `5000` | How long an unreachable peer's cursor stays before it is removed. A phone page that is briefly hidden keeps its cursor; a closed tab's cursor also stays this long. |
| `syncTimeoutMs` | `3000` | How long to wait for one peer's answer before asking the next. A large document arrives in parts, and each part starts the wait again. It is also how long a peer with nobody else in the room waits before `synced`. |

- `provider.synced` is `true` once a peer's copy of the document has been applied. It is also `true` when the
  room had no one else after `syncTimeoutMs`, or once every peer was asked and none answered.
- `provider.on('synced', f)` / `provider.off('synced', f)`: fires once, when `synced` turns true.
- `provider.awareness`: the y-protocols `Awareness` to hand to your editor binding.
- `provider.destroy()`: removes your cursor at the others at once while the page is live, stops syncing and
  detaches from the room. The room stays joined. Called as the page unloads (a closed tab, a reload), its removal
  goes down with the page, and the others drop your cursor after `leaveHoldMs`.

## How it syncs

- **Edits.** An edit that fits a datagram (about 1 KB encoded; most keystrokes) is broadcast. A larger one, a
  paste for example, goes reliably to each peer, split into parts when it exceeds 64 KB.
- **Joining.** A new peer asks one peer for the document, preferring a direct connection over a relayed one or
  a path through other peers. The document crosses the network once per joiner. The peers exchange state
  vectors both ways, so the joiner's offline edits (restored by `y-indexeddb`, say) reach the others too.
- **Repair.** Yjs notices when an update arrives before one it depends on, and the provider asks that peer for
  what is missing at once. The periodic exchange (`resyncMs`) covers what nothing else notices, such as a lost
  deletion or a lost last update.
- **Awareness.** Each peer sends only its own state. A peer that calls `destroy()` in a live page disappears at
  once. One that becomes unreachable disappears after `leaveHoldMs`, and so does a page that closes or reloads: its
  last messages go down with it, so the others see it go quiet (about `leaveHoldMs` plus half a second).

## Keeping documents

**jsflow does not store documents.** A room holds peers, not data. When the last peer leaves, the document lives
on only where you keep it:

- **In each browser:** [`y-indexeddb`](https://github.com/yjs/y-indexeddb) next to the provider. A returning
  user opens with their copy at once, and their offline edits merge when they rejoin.
- **On your backend:** save `Y.encodeStateAsUpdate(doc)` from a client (debounced, for example every few
  seconds while it changes, and on `pagehide`), and apply the saved state with `Y.applyUpdate` before you create
  the provider. Yjs merges, so it does not matter which client saved last or whether two saved at once.
- **Across rooms:** to move or copy a document between rooms, load its saved state into a new `Y.Doc` and join
  the other room with it. Every peer that applies the state has the same document.

## Limits

- Peers per room follow your jsflow plan.
- A joiner receives the whole document from one peer over one reliable stream. Measured with 2 peers: 5 MB in
  about 2 s over a direct connection, 13 s through a relay (TURN), and 10 MB in 27 s through a relay. Keep a
  document under a few megabytes, or load your saved copy before creating the provider: the joiner then receives
  only what it lacks. Large documents through a relay need jsflow-sdk 1.1.1 or later.
- If the one peer sending a joiner the document becomes unreachable partway and stays away longer than
  `syncTimeoutMs`, with no other peer in the room, the joiner reports `synced` with what it has. The rest arrives
  when that peer is back.
- Keep an awareness state under about 1 KB, so that it travels as one datagram.

## Licence

MIT
