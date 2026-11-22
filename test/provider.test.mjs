// y-jsflow against the in-process hub (test/hub.mjs): convergence under loss, late joiners, reload, leave, large updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { JsflowProvider } from '../src/index.js';
import { Hub } from './hub.mjs';

const FAST = { resyncMs: 300, leaveHoldMs: 150, syncTimeoutMs: 120 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); }
}
// the content (doc.toJSON() lists only the types a doc has opened, so each is opened by name) and the state vector
const content = (d) => JSON.stringify([d.getText('t').toString(), Object.entries(d.getMap('m').toJSON()).sort(([a], [b]) => (a < b ? -1 : 1))]);  // map keys come in any order
const same = (docs) => docs.every((d) => content(d) === content(docs[0])
  && Buffer.from(Y.encodeStateVector(d)).equals(Buffer.from(Y.encodeStateVector(docs[0]))));

function peer(hub, opts = {}, doc = new Y.Doc()) {
  const room = hub.join();
  const p = new JsflowProvider(room, doc, { ...FAST, ...opts });
  return { room, doc, p, text: doc.getText('t'), map: doc.getMap('m') };
}
const done = (...ps) => { for (const x of ps) { x.p.destroy(); x.doc.destroy(); } };

// what a room sent, by kind (byte 0; a part counts as its inner kind)
function spy(room) {
  const sent = [];
  const rel = room.sendReliable.bind(room), bc = room.broadcast.bind(room);
  room.sendReliable = (to, d, o) => { sent.push({ to, kind: d[0] === 0x15 ? d[1] : d[0], reliable: true }); return rel(to, d, o); };
  room.broadcast = (d, o) => { sent.push({ to: null, kind: d[0], reliable: false }); return bc(d, o); };
  return sent;
}

test('three peers editing at once converge under 5 % datagram loss, duplicates and reordering', async () => {
  const hub = new Hub({ loss: 0.05, dup: 0.05, delayMs: [0, 25], seed: 7 });
  const a = peer(hub), b = peer(hub), c = peer(hub);
  await until(() => a.p.synced && b.p.synced && c.p.synced, 3000, 'synced');
  for (let i = 0; i < 300; i++) {
    const x = [a, b, c][i % 3];
    if (i % 7 === 6 && x.text.length > 3) x.text.delete(i % x.text.length, 2);
    else x.text.insert(i % (x.text.length + 1), String.fromCharCode(97 + (i % 26)));
    if (i % 5 === 0) x.map.set(`k${i % 11}`, i);
    if (i % 20 === 0) await sleep(5);
  }
  await until(() => same([a.doc, b.doc, c.doc]), 8000, 'convergence');
  assert.ok(a.text.length > 0);
  done(a, b, c);
});

test('a late joiner asks one peer for the document and downloads it once, gets all of it, and reports synced once', async () => {
  const hub = new Hub({ delayMs: [1, 5] });
  const a = peer(hub), b = peer(hub), c = peer(hub);
  await until(() => a.p.synced && b.p.synced && c.p.synced, 3000, 'synced');
  for (let i = 0; i < 200; i++) [a, b, c][i % 3].text.insert(0, `${i},`);
  await until(() => same([a.doc, b.doc, c.doc]), 3000, 'first three');
  const room = hub.join(), sent = spy(room), doc = new Y.Doc(), step2 = new Map();   // peer -> step 2 bytes received
  let syncedEvents = 0, askedBeforeSynced = null;   // whom it had asked when the first answer came (this listener runs before the provider's)
  room.on('message', (from, d) => {
    if (d[0] !== 0x12 && !(d[0] === 0x15 && d[1] === 0x12)) return;
    askedBeforeSynced ??= new Set(sent.filter((s) => s.kind === 0x11).map((s) => s.to));
    step2.set(from, (step2.get(from) ?? 0) + d.length);
  });
  const d = { room, doc, p: new JsflowProvider(room, doc, { ...FAST, resyncMs: 60000 }) };
  d.p.on('synced', () => syncedEvents++);
  await until(() => d.p.synced, 3000, 'late joiner synced');
  await until(() => same([a.doc, b.doc, c.doc, doc]), 3000, 'late joiner has everything');
  assert.equal(askedBeforeSynced.size, 1, `asked ${[...askedBeforeSynced]}`);
  await sleep(100);
  assert.equal(syncedEvents, 1);
  // after synced it sends its state vector to the peers that sent theirs (the exchange both ways): they answer with
  // what it still lacks, here nothing, so the document came once
  const size = Y.encodeStateAsUpdate(a.doc).length, big = [...step2.values()].filter((n) => n > size / 2);
  assert.equal(big.length, 1, `step 2 bytes by peer: ${JSON.stringify([...step2])}, document ${size}`);
  done(a, b, c, d);
});

test('a reload: the page comes back with a new id and its saved state; its offline edits reach the others, its old cursor goes', async () => {
  const hub = new Hub({ delayMs: [1, 5] });
  const a = peer(hub), b = peer(hub), c = peer(hub);
  c.p.awareness.setLocalStateField('user', { name: 'C' });
  await until(() => a.p.synced && b.p.synced && c.p.synced, 3000, 'synced');
  a.text.insert(0, 'hello ');
  await until(() => same([a.doc, b.doc, c.doc]), 3000, 'shared');
  await until(() => a.p.awareness.states.get(c.doc.clientID)?.user?.name === 'C', 3000, 'C\'s cursor at A');
  // the reload: saved state (as y-indexeddb would keep it), an edit made while the page was gone, a new id
  const saved = Y.encodeStateAsUpdate(c.doc), oldClient = c.doc.clientID;
  c.room.drop(); c.p.destroy(); c.doc.destroy();
  const doc = new Y.Doc(); Y.applyUpdate(doc, saved); doc.getText('t').insert(0, 'offline ');
  const c2 = peer(hub, {}, doc);
  await until(() => same([a.doc, b.doc, c2.doc]), 3000, 'offline edit everywhere');
  assert.ok(a.text.toString().includes('offline '));
  await until(() => !a.p.awareness.states.has(oldClient) && !b.p.awareness.states.has(oldClient), 3000, 'old cursor removed');
  done(a, b, c2);
});

test('a leave: destroy() removes my cursor at the others at once, well before the leave hold', async () => {
  const hub = new Hub({ delayMs: [1, 5] });
  const a = peer(hub, { leaveHoldMs: 10000 }), b = peer(hub, { leaveHoldMs: 10000 });
  b.p.awareness.setLocalStateField('user', { name: 'B' });
  await until(() => a.p.awareness.states.get(b.doc.clientID)?.user?.name === 'B', 3000, 'B\'s cursor at A');
  const t0 = Date.now();
  b.p.destroy(); b.room.leave();
  await until(() => !a.p.awareness.states.has(b.doc.clientID), 3000, 'B\'s cursor removed');
  assert.ok(Date.now() - t0 < 1000);
  b.doc.destroy(); done(a);
});

test('a cursor survives a short absence (a hidden page that comes back) and goes after a long one', async () => {
  const hub = new Hub({ delayMs: [1, 3] });
  const a = peer(hub, { leaveHoldMs: 300 }), b = peer(hub);
  b.p.awareness.setLocalStateField('user', { name: 'B' });
  await until(() => a.p.awareness.states.get(b.doc.clientID)?.user?.name === 'B', 3000, 'B\'s cursor at A');
  a.room._emit('peer', b.room.id, false); await sleep(100); a.room._emit('peer', b.room.id, true);
  await sleep(400);
  assert.equal(a.p.awareness.states.get(b.doc.clientID)?.user?.name, 'B', 'kept across a 100 ms absence');
  a.room._emit('peer', b.room.id, false);
  await until(() => !a.p.awareness.states.has(b.doc.clientID), 2000, 'removed after the hold');
  done(a, b);
});

test('a 200 KB paste travels in parts and arrives whole', async () => {
  const hub = new Hub({ delayMs: [1, 5] });
  const a = peer(hub), b = peer(hub), c = peer(hub);
  await until(() => a.p.synced && b.p.synced && c.p.synced, 3000, 'synced');
  const sent = spy(a.room);
  const big = 'x'.repeat(200_000);
  a.text.insert(0, big);
  await until(() => same([a.doc, b.doc, c.doc]), 5000, 'paste everywhere');
  assert.equal(b.text.toString(), big);
  assert.ok(sent.filter((s) => s.kind === 0x13 && s.reliable).length >= 2 * 4, 'parts to both peers');
  done(a, b, c);
});

test('a document that takes longer than syncTimeoutMs to arrive: the joiner waits for it while parts come, synced only with all of it', async () => {
  const hub = new Hub({ delayMs: [30, 30] });          // each reliable message 30 ms after the one before: ~20 parts take ~600 ms
  const a = peer(hub);
  a.text.insert(0, 'y'.repeat(1_200_000));
  await until(() => a.p.synced, 2000, 'a synced');
  const room = hub.join(), doc = new Y.Doc(), p = new JsflowProvider(room, doc, { ...FAST, resyncMs: 60000, syncTimeoutMs: 300 });   // the first part comes after ~3 hops of 30 ms
  let lenAtSynced = -1; p.on('synced', () => (lenAtSynced = doc.getText('t').length));
  await until(() => p.synced, 5000, 'joiner synced');
  assert.equal(lenAtSynced, 1_200_000, 'synced with the whole document, not after the first wait');
  p.destroy(); doc.destroy(); done(a);
});

test('the asked peer drops while answering and comes back: the joiner asks it again, not synced without its document', async () => {
  const hub = new Hub({ delayMs: [30, 30] });
  const a = peer(hub);
  a.text.insert(0, 'z'.repeat(1_200_000));
  await until(() => a.p.synced, 2000, 'a synced');
  const room = hub.join(), doc = new Y.Doc(), p = new JsflowProvider(room, doc, { ...FAST, resyncMs: 60000, syncTimeoutMs: 300 });
  let lenAtSynced = -1; p.on('synced', () => (lenAtSynced = doc.getText('t').length));
  // the link drops after a few parts: the joiner sees a down, and the rest of that answer (its part id) never arrives
  let parts = 0, cutId = null;
  const deliver = hub.deliver.bind(hub);
  hub.deliver = (from, to, data, info) => {
    if (to === room.id && data[0] === 0x15) {
      const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2);
      if (id === cutId) return;
      if (cutId === null && ++parts === 4) {          // both ends see the link down (the sender drops its queue to the joiner)
        cutId = id; a.room.chains.delete(room.id); room._emit('peer', a.room.id, false); a.room._emit('peer', room.id, false);
        setTimeout(() => { room._emit('peer', a.room.id, true); a.room._emit('peer', room.id, true); }, 200);
        return;
      }
    }
    deliver(from, to, data, info);
  };
  await until(() => p.synced, 8000, 'joiner synced');
  assert.equal(lenAtSynced, 1_200_000, 'synced with the whole document');
  p.destroy(); doc.destroy(); done(a);
});

test('a link that drops for a moment mid-answer (the SDK keeps delivering): the document comes once, not started over', async () => {
  const hub = new Hub({ delayMs: [30, 30] });
  const a = peer(hub);
  a.text.insert(0, 'w'.repeat(1_200_000));
  await until(() => a.p.synced, 2000, 'a synced');
  const room = hub.join(), doc = new Y.Doc(), p = new JsflowProvider(room, doc, { ...FAST, resyncMs: 60000, syncTimeoutMs: 300, leaveHoldMs: 1000 });
  let lenAtSynced = -1, step2 = 0, parts = 0;
  p.on('synced', () => (lenAtSynced = doc.getText('t').length));
  room.on('message', (from, d) => {
    if (d[0] === 0x15 && d[1] === 0x12) { step2 += d.length; if (++parts === 4) {   // both ends see the peer down for 100 ms
      room._emit('peer', a.room.id, false); a.room._emit('peer', room.id, false);
      setTimeout(() => { room._emit('peer', a.room.id, true); a.room._emit('peer', room.id, true); }, 100);
    } }
  });
  await until(() => p.synced, 8000, 'joiner synced');
  assert.equal(lenAtSynced, 1_200_000, 'synced with the whole document');
  const size = Y.encodeStateAsUpdate(a.doc).length;
  assert.ok(step2 < 1.2 * size, `received ${step2} step 2 bytes for a ${size} byte document: not started over`);
  p.destroy(); doc.destroy(); done(a);
});

test('alone in the room: synced after the wait, with nothing asked', async () => {
  const hub = new Hub();
  const a = peer(hub);
  assert.equal(a.p.synced, false);
  await until(() => a.p.synced, 1000, 'synced alone');
  done(a);
});

test('a joiner that starts alone (join() resolves before the first link) asks as soon as a peer comes up, not after the wait', async () => {
  const hub = new Hub({ delayMs: [1, 3] });
  const a = peer(hub);
  a.text.insert(0, 'from a');
  await until(() => a.p.synced, 2000, 'a synced');
  const room = hub.join(); room.state = 'joining';          // linked to nobody yet: peers() is empty
  const doc = new Y.Doc(), p = new JsflowProvider(room, doc, { ...FAST, syncTimeoutMs: 3000 });
  await sleep(50);
  const t0 = Date.now();
  room.state = 'connected'; room._emit('state', 'connected');
  await until(() => p.synced, 2000, 'synced');
  assert.ok(Date.now() - t0 < 500, `synced after ${Date.now() - t0} ms, not the 3000 ms wait`);
  assert.equal(doc.getText('t').toString(), 'from a');
  p.destroy(); doc.destroy(); done(a);
});

test('a peer that never answers is skipped: the joiner asks the next one', async () => {
  const hub = new Hub({ delayMs: [1, 3] });
  const silent = hub.join();                 // in the room, no provider: never answers
  const a = peer(hub);
  a.text.insert(0, 'from a');
  await until(() => a.p.synced, 2000, 'a synced');
  const b = peer(hub);
  await until(() => b.p.synced, 2000, 'b synced past the silent peer');
  await until(() => same([a.doc, b.doc]), 2000, 'b has a\'s text');
  done(a, b); silent.drop();
});

test('destroy() detaches every listener; a garbage message is dropped, not thrown', async () => {
  const hub = new Hub();
  const a = peer(hub), b = peer(hub);
  const before = a.room.listeners();
  assert.ok(before >= 3);
  const warn = console.warn; console.warn = () => {};
  try { b.room.broadcast(new Uint8Array([0x13, 1, 2, 3]), { channel: 13 }); await sleep(20); } finally { console.warn = warn; }
  a.p.destroy();
  assert.equal(a.room.listeners(), 0);
  a.doc.destroy(); done(b);
});

test('channel must be an app channel', () => {
  const hub = new Hub(), room = hub.join(), doc = new Y.Doc();
  assert.throws(() => new JsflowProvider(room, doc, { channel: 14 }), /channel/);
  doc.destroy();
});
