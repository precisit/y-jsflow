// y-jsflow: a Yjs provider over a jsflow room.
// It takes a joined Room and syncs one Y.Doc and a y-protocols Awareness over one app channel.
//
// Wire (one jsflow message each; byte 0 is the kind, version 1 in the high nibble):
//   0x11 sync step 1   [sv]       my state vector: "send me what I lack"           sendReliable to one peer
//   0x12 sync step 2   [update]   the diff for a step 1                            sendReliable to the asker
//   0x13 update        [update]   a local change                                   broadcast if it fits a datagram, else sendReliable to each peer
//   0x14 awareness     [update]   my own awareness state (never another's)        broadcast; sendReliable to a new peer
//   0x15 part          [kind u8][id u32][index u16][count u16][bytes]   a reliable message above MAX_RELIABLE, in order
//
// Late joiner: asks one peer (direct before relay before mesh), the next after syncTimeoutMs without a part of its
// answer (a large document arrives in parts, for many seconds over a relay). A synced peer sends
// its step 1 to every peer that comes up, so a newcomer's own edits flow back without a full exchange both ways.
// Repair: an update that leaves Yjs with pending structs (one before it was lost) asks its sender at once; every
// resyncMs each peer sends step 1 to one random peer (lost deletions, a lost last update).
// Awareness: each peer sends only its own state, so a peer's entries are known exactly and removed leaveHoldMs
// after it becomes unreachable (a hidden Safari page says BYE and comes back), with their clocks, so that it is
// seen again at once if it comes back later; a page back after 'away' sends its state to every peer again.
import * as Y from 'yjs';
import { encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates, Awareness } from 'y-protocols/awareness';

const MAX_DATAGRAM = 1052, MAX_RELIABLE = 65536;   // jsflow-sdk 1.x (jsflow.d.ts); the SDK is not imported
const STEP1 = 0x11, STEP2 = 0x12, UPDATE = 0x13, AWARENESS = 0x14, PART = 0x15;
const PART_HEAD = 10, PART_BYTES = MAX_RELIABLE - PART_HEAD;
const RANK = { direct: 0, relay: 1, mesh: 2 };

const frame = (kind, body) => { const b = new Uint8Array(body.length + 1); b[0] = kind; b.set(body, 1); return b; };

export class JsflowProvider {
  /**
   * @param {import('jsflow-sdk').Room} room a joined room
   * @param {Y.Doc} doc
   * @param {{ channel?: number, awareness?: Awareness, resyncMs?: number, leaveHoldMs?: number, syncTimeoutMs?: number }} [opts]
   */
  constructor(room, doc, opts = {}) {
    const channel = opts.channel ?? 13;
    if (!Number.isInteger(channel) || channel < 0 || channel > 13) throw new TypeError('y-jsflow: channel must be an integer 0–13');
    this.room = room; this.doc = doc; this.channel = channel;
    this.awareness = opts.awareness ?? new Awareness(doc);
    this.synced = false;
    this.resyncMs = opts.resyncMs ?? 15000; this.leaveHoldMs = opts.leaveHoldMs ?? 5000; this.syncTimeoutMs = opts.syncTimeoutMs ?? 3000;
    this._ownAwareness = !opts.awareness;
    this._listeners = new Map();
    this._timers = new Set();
    this._clients = new Map();     // peer -> Set of awareness client ids it announced
    this._holds = new Map();       // peer -> timer: an unreachable peer's queue, parts and awareness go when it fires
    this._parts = new Map();       // `${peer}:${id}` -> { kind, count, chunks: [] }
    this._queues = new Map();      // peer -> { items: [], running }: reliable sends, in order, waiting for queue space
    this._partId = 0;
    this._asked = new Set();       // peers asked for sync step 2 this round
    this._askedPeer = null;        // the peer asked last, while not synced
    this._answering = false;       // a part of its answer has arrived: it is answering, not silent
    this._asking = null;           // the timer of the outstanding ask, or of the wait while no peer is reachable
    this._alone = false;           // _asking is that wait: a peer coming up ends it at once
    this._lastGapAsk = new Map();  // peer -> ms
    this._greeted = new Set();     // peers I sent step 1 to since they came up: they send me what I lack
    this._owed = new Set();        // peers whose step 1 came while I was syncing: my step 1 goes to them once synced
    this._destroyed = false;
    this._away = false;            // the room said 'away' (BYE on hide) and is not connected again yet

    this._onUpdate = (update, origin) => { if (origin !== this) this._sendUpdate(update); };
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin !== 'local') return;   // remote states (origin: this provider) and timeouts are not ours to send
      const mine = [...added, ...updated, ...removed].filter((c) => c === this.doc.clientID);
      if (mine.length) this._sendAwareness(null);
    };
    this._onMessage = (from, data, info) => { if (info.channel === this.channel && data.length) this._receive(from, data); };
    this._onPeer = (peer, up) => up ? this._peerUp(peer) : this._peerDown(peer);
    this._onState = (s) => {
      if (s === 'away') this._away = true;
      if (s === 'connected') {
        if (this._away) { this._away = false; this._resendAwareness(); }
        if (!this.synced) this._askNow();
      }
      if (s === 'left' || s === 'superseded' || s === 'evicted') this._stop();
    };

    doc.on('update', this._onUpdate);
    this.awareness.on('update', this._onAwareness);
    room.on('message', this._onMessage).on('peer', this._onPeer).on('state', this._onState);
    for (const p of room.peers()) this._peerUp(p, true);
    this._ask();
    this._scheduleResync();
  }

  /** @param {'synced'} ev @param {(synced: boolean) => void} f */
  on(ev, f) { if (!this._listeners.has(ev)) this._listeners.set(ev, new Set()); this._listeners.get(ev).add(f); return this; }
  off(ev, f) { this._listeners.get(ev)?.delete(f); return this; }
  _emit(ev, ...a) { for (const f of this._listeners.get(ev) ?? []) f(...a); }

  /** Clears my awareness state at the others, stops syncing and detaches. The room stays joined: leave() is the app's. */
  destroy() {
    if (this._destroyed) return;
    if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(null);   // broadcast as a removal by _onAwareness
    this._stop();
    if (this._ownAwareness) this.awareness.destroy();
  }

  _stop() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.doc.off('update', this._onUpdate);
    this.awareness.off('update', this._onAwareness);
    this.room.off('message', this._onMessage).off('peer', this._onPeer).off('state', this._onState);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear(); this._holds.clear(); this._parts.clear(); this._queues.clear(); this._greeted.clear(); this._owed.clear();
  }

  _later(ms, f) { const t = setTimeout(() => { this._timers.delete(t); if (!this._destroyed) f(); }, ms); this._timers.add(t); return t; }
  _cancel(t) { if (t) { clearTimeout(t); this._timers.delete(t); } }

  _setSynced() {
    if (this.synced) return;
    this.synced = true; this._cancel(this._asking); this._asking = null; this._alone = false;
    const peers = new Set(this.room.peers());
    for (const p of this._owed) if (peers.has(p) && !this._greeted.has(p)) this._sendStep1(p);
    this._owed.clear();
    this._emit('synced', true);
  }

  // ---- sync: whom to ask ----
  _ranked() {
    const peers = this.room.peers();
    const rank = (p) => { try { return RANK[this.room.path?.(p)] ?? 3; } catch { return 3; } };
    return peers.map((p, i) => [p, rank(p), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
  }

  _ask() {
    if (this.synced || this._destroyed || this._asking) return;
    const peers = this._ranked();
    if (!peers.length) {                                    // alone (or not linked yet): synced if still alone after a wait
      this._alone = true;
      this._asking = this._later(this.syncTimeoutMs, () => { this._asking = null; this._alone = false; if (!this.room.peers().length) this._setSynced(); else this._ask(); });
      return;
    }
    let next = peers.find((p) => !this._asked.has(p));
    if (next === undefined) {                              // every reachable peer asked, none answered: no provider there
      this._setSynced();                                   // to sync with now (a late answer still applies)
      return;
    }
    this._asked.add(next); this._askedPeer = next; this._answering = false;
    this._sendStep1(next);
    this._waitAnswer();
  }

  // the wait for the asked peer's answer; each part of it starts the wait again
  _waitAnswer() {
    this._cancel(this._asking);
    this._asking = this._later(this.syncTimeoutMs, () => { this._asking = null; this._ask(); });
  }

  // a peer is reachable now: if only the alone wait is pending, ask at once (join() resolves before the first link, so
  // a joiner usually starts alone; waiting out syncTimeoutMs would delay every join's synced by that much)
  _askNow() {
    if (this.synced || this._destroyed) return;
    if (this._alone) { this._cancel(this._asking); this._asking = null; this._alone = false; }
    this._ask();
  }

  _sendStep1(peer) { this._greeted.add(peer); this._reliable(peer, STEP1, Y.encodeStateVector(this.doc)); }

  _scheduleResync() {
    const ms = this.resyncMs * (0.8 + 0.4 * Math.random());
    this._later(ms, () => {
      const peers = this.room.peers();
      if (peers.length) this._sendStep1(peers[Math.floor(Math.random() * peers.length)]);
      this._scheduleResync();
    });
  }

  // ---- peers ----
  _peerUp(peer, initial = false) {
    const hold = this._holds.get(peer);
    if (hold) { this._cancel(hold); this._holds.delete(peer); }
    if (this.awareness.getLocalState() !== null) this._sendAwareness(peer);
    if (this.synced) this._sendStep1(peer);
    else if (!initial) this._askNow();
  }

  _peerDown(peer) {
    // the asked peer went away while answering (a dropped link): ask it again if it comes back, rather than count it
    // as a peer that never answers (and be 'synced' without its document)
    if (!this.synced && peer === this._askedPeer && this._answering) this._asked.delete(peer);
    if (this._holds.has(peer)) return;
    // Unreachable is not gone: a link that drops for a moment (a relay over its bandwidth cap, a hidden phone page)
    // comes back, and the SDK keeps its reliable stream meanwhile. So for leaveHoldMs the peer keeps what is queued
    // for it, a message arriving in parts and its cursor; a large document is not started over at every blip.
    this._holds.set(peer, this._later(this.leaveHoldMs, () => {
      this._holds.delete(peer);
      this._queues.delete(peer); this._greeted.delete(peer); this._owed.delete(peer);
      for (const k of this._parts.keys()) if (k.startsWith(`${peer}:`)) this._parts.delete(k);
      // its entries go, and so do their clocks: y-protocols keeps a removed client's clock and takes only a higher
      // one, so the peer coming back (resending its state at the same clock) would be ignored until its next change.
      // An id another peer announced since is that peer's now (_awareness), not in this set, and stays.
      const ids = [...(this._clients.get(peer) ?? [])];
      this._clients.delete(peer);
      const shown = ids.filter((c) => this.awareness.states.has(c));
      if (shown.length) removeAwarenessStates(this.awareness, shown, this);
      for (const c of ids) this.awareness.meta.delete(c);
    }));
  }

  // ---- sending ----
  _sendUpdate(update) {
    if (update.length + 1 <= MAX_DATAGRAM) { this.room.broadcast(frame(UPDATE, update), { channel: this.channel }); return; }
    for (const p of this.room.peers()) this._reliable(p, UPDATE, update);
  }

  // Back after 'away' (BYE on hide: phones, desktop Safari): the others dropped my cursor after leaveHoldMs, but a
  // page hidden for less than the mesh's dead window (20 s) keeps its links, so its room reports no peer down and
  // up, and _peerUp does not run. My state goes to every peer again, reliably, as to a new peer; a peer that still
  // has it (a hide shorter than its hold) ignores it, at the same clock.
  _resendAwareness() {
    if (this.awareness.getLocalState() === null) return;
    for (const p of this.room.peers()) this._sendAwareness(p);
  }

  _sendAwareness(peer) {
    const body = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    if (peer !== null) { this._reliable(peer, AWARENESS, body); return; }
    if (body.length + 1 <= MAX_DATAGRAM) this.room.broadcast(frame(AWARENESS, body), { channel: this.channel });
    else for (const p of this.room.peers()) this._reliable(p, AWARENESS, body);
  }

  _reliable(peer, kind, body) {
    const msgs = [];
    if (body.length + 1 <= MAX_RELIABLE) msgs.push(frame(kind, body));
    else {
      const id = (this._partId = (this._partId + 1) >>> 0), count = Math.ceil(body.length / PART_BYTES);
      if (count > 0xffff) throw new RangeError('y-jsflow: message too large');
      for (let i = 0; i < count; i++) {
        const chunk = body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES), m = new Uint8Array(PART_HEAD + chunk.length), v = new DataView(m.buffer);
        m[0] = PART; m[1] = kind; v.setUint32(2, id); v.setUint16(6, i); v.setUint16(8, count); m.set(chunk, PART_HEAD);
        msgs.push(m);
      }
    }
    let q = this._queues.get(peer);
    if (!q) this._queues.set(peer, (q = { items: [], running: false }));
    q.items.push(...msgs);
    if (!q.running) this._pump(peer, q);
  }

  // In order per peer; a full SDK queue (sendReliable resolves false) is retried, not dropped.
  async _pump(peer, q) {
    q.running = true;
    try {
      while (q.items.length && !this._destroyed && this._queues.get(peer) === q) {
        let ok = false;
        try { ok = await this.room.sendReliable(peer, q.items[0], { channel: this.channel }); } catch { ok = false; }
        if (ok) q.items.shift();
        else await new Promise((r) => this._later(200, r));
      }
    } finally { q.running = false; }
  }

  // ---- receiving ----
  _receive(from, data) {
    const kind = data[0];
    if (kind === PART) return this._part(from, data);
    this._handle(from, kind, data.subarray(1));
  }

  _part(from, m) {
    if (m.length < PART_HEAD) return;
    const v = new DataView(m.buffer, m.byteOffset, m.byteLength), kind = m[1], id = v.getUint32(2), index = v.getUint16(6), count = v.getUint16(8);
    const key = `${from}:${id}`;
    let p = this._parts.get(key);
    if (!p) { if (index !== 0) return; this._parts.set(key, (p = { kind, count, chunks: [] })); }
    if (index !== p.chunks.length || count !== p.count) { this._parts.delete(key); return; }   // reliable is in order: anything else is a restart
    p.chunks.push(m.slice(PART_HEAD));
    if (p.kind === STEP2 && !this.synced && from === this._askedPeer && this._asking && !this._alone) { this._answering = true; this._waitAnswer(); }
    if (p.chunks.length < count) return;
    this._parts.delete(key);
    const body = new Uint8Array(p.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of p.chunks) { body.set(c, o); o += c.length; }
    this._handle(from, kind, body);
  }

  _handle(from, kind, body) {
    try {
      if (kind === STEP1) {
        this._reliable(from, STEP2, Y.encodeStateAsUpdate(this.doc, body));
        // the exchange both ways (as y-protocols' sync does): its step 1 gets it what it lacks; mine gets me what I
        // lack, which matters when it saw me before I saw it (its updates in between went to everyone but me).
        // While syncing, only after the one peer asked has answered: a joiner downloads the document once.
        if (!this._greeted.has(from)) { if (this.synced) this._sendStep1(from); else this._owed.add(from); }
      }
      else if (kind === STEP2) { Y.applyUpdate(this.doc, body, this); this._setSynced(); }
      else if (kind === UPDATE) { Y.applyUpdate(this.doc, body, this); this._gapCheck(from); }
      else if (kind === AWARENESS) this._awareness(from, body);
    } catch (e) {
      // a malformed message from one peer must not stop the provider; Yjs throws on garbage
      if (typeof console !== 'undefined') console.warn('y-jsflow: dropped a message from peer', from, e?.message ?? e);
    }
  }

  // Yjs keeps structs whose predecessors it has not seen as pending: one update before this was lost. Ask its
  // sender (at most once a second each) for a diff.
  _gapCheck(from) {
    const s = this.doc.store;
    if (!s?.pendingStructs && !s?.pendingDs) return;
    const now = Date.now();
    if (now - (this._lastGapAsk.get(from) ?? 0) < 1000) return;
    this._lastGapAsk.set(from, now);
    this._sendStep1(from);
  }

  _awareness(from, body) {
    const hold = this._holds.get(from);
    if (hold) { this._cancel(hold); this._holds.delete(from); }
    const seen = [];
    const note = ({ added, updated, removed }, origin) => { if (origin === this) seen.push([added, updated, removed]); };
    this.awareness.on('update', note);
    try { applyAwarenessUpdate(this.awareness, body, this); } finally { this.awareness.off('update', note); }
    let set = this._clients.get(from);
    if (!set) this._clients.set(from, (set = new Set()));
    for (const [added, updated, removed] of seen) {
      for (const c of [...added, ...updated]) {
        if (c === this.doc.clientID) continue;
        set.add(c);
        // the same client id from a new peer (a page offline and back within leaveHoldMs): its entry is the new
        // peer's, so the old peer's hold running out leaves it alone
        for (const [p, s] of this._clients) if (p !== from) s.delete(c);
      }
      for (const c of removed) set.delete(c);
    }
  }
}
