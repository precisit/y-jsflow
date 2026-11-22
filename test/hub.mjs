// An in-process stand-in for jsflow rooms, for the provider's tests: every peer reaches every other (a full mesh,
// path 'direct'); broadcast is a datagram (loss, duplication, delay on demand); sendReliable is in order per pair and
// never lost. peer events fire on join, leave and drop, as the SDK's do.
export class Hub {
  constructor({ loss = 0, dup = 0, delayMs = [0, 0], seed = 1 } = {}) {
    this.rooms = new Map(); this.next = 1; this.loss = loss; this.dup = dup; this.delayMs = delayMs; this.s = seed;
    this.sent = { broadcast: 0, reliable: 0, bytes: 0 };
  }
  rand() { this.s = (this.s * 1103515245 + 12345) & 0x7fffffff; return this.s / 0x7fffffff; }
  delay() { const [a, b] = this.delayMs; return a + (b - a) * this.rand(); }
  join() {
    const r = new FakeRoom(this, this.next++);
    for (const o of this.rooms.values()) { o._emit('peer', r.id, true); }
    this.rooms.set(r.id, r);
    for (const o of this.rooms.values()) if (o !== r) r._emit('peer', o.id, true);
    return r;
  }
  remove(r) {
    if (!this.rooms.delete(r.id)) return;
    for (const o of this.rooms.values()) o._emit('peer', r.id, false);
  }
  deliver(from, to, data, info) {
    const r = this.rooms.get(to);
    if (!r) return;
    r._emit('message', from, data, info);
  }
}

export class FakeRoom {
  constructor(hub, id) { this.hub = hub; this.id = id; this.state = 'connected'; this.l = new Map(); this.chains = new Map(); this.held = false; }
  peers() { return this.state === 'connected' ? [...this.hub.rooms.keys()].filter((p) => p !== this.id) : []; }
  path(p) { return this.hub.rooms.has(p) ? 'direct' : null; }
  on(ev, f) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev).add(f); return this; }
  off(ev, f) { this.l.get(ev)?.delete(f); return this; }
  _emit(ev, ...a) { for (const f of [...(this.l.get(ev) ?? [])]) f(...a); }
  listeners() { let n = 0; for (const s of this.l.values()) n += s.size; return n; }
  broadcast(data, o = {}) {
    if (data.length > 1052) throw new RangeError('datagram too large');
    const h = this.hub; h.sent.broadcast++; h.sent.bytes += data.length;
    for (const to of this.peers()) {
      const copies = h.rand() < h.loss ? 0 : h.rand() < h.dup ? 2 : 1;
      for (let i = 0; i < copies; i++) setTimeout(() => h.deliver(this.id, to, data.slice(), { channel: o.channel ?? 0, broadcast: true, reliable: false }), h.delay());
    }
  }
  async sendReliable(to, data, o = {}) {
    if (data.length > 65536) throw new RangeError('reliable message too large');
    const h = this.hub; h.sent.reliable++; h.sent.bytes += data.length;
    if (this.held) return false;
    const prev = this.chains.get(to) ?? Promise.resolve();       // in order per pair
    const d = h.delay();
    const p = prev.then(() => new Promise((r) => setTimeout(() => { h.deliver(this.id, to, data.slice(), { channel: o.channel ?? 0, broadcast: false, reliable: true }); r(); }, d)));
    this.chains.set(to, p);
    return true;
  }
  leave() { this.state = 'left'; this._emit('state', 'left'); this.hub.remove(this); }
  drop() { this.hub.remove(this); }  // gone without a goodbye (a crash, a reload): the others see it down
}
