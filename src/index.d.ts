import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

/** The part of a jsflow-sdk Room the provider uses (jsflow-sdk 1.0 or later; path() from 1.1 is used when present). */
export interface RoomLike {
  readonly state: string;
  peers(): number[];
  path?(peer: number): 'direct' | 'relay' | 'mesh' | null;
  on(ev: 'message', f: (from: number, data: Uint8Array, info: { channel: number; broadcast: boolean; reliable: boolean }) => void): this;
  on(ev: 'peer', f: (id: number, up: boolean) => void): this;
  on(ev: 'state', f: (s: string) => void): this;
  off(ev: string, f: (...a: any[]) => void): this;
  broadcast(data: Uint8Array, o?: { channel?: number }): void;
  sendReliable(to: number, data: Uint8Array, o?: { channel?: number }): Promise<boolean>;
}

export interface JsflowProviderOptions {
  /** The app channel the provider uses for everything, 0–13. Default 13; keep it free of the app's own messages. */
  channel?: number;
  /** An existing y-protocols Awareness for this document. Default: a new one, destroyed with the provider. To reconnect, give the new provider the same Awareness: a new one starts its clock at 0 and the others ignore it until it passes the old one. */
  awareness?: Awareness;
  /** How often (ms, ±20 %) the provider compares state with one random peer, to repair lost updates. Default 15000. */
  resyncMs?: number;
  /** How long (ms) a peer that became unreachable keeps its awareness entries (cursor, name). Default 5000. */
  leaveHoldMs?: number;
  /** How long (ms) to wait for one peer's answer before asking the next, counted from the last part of it received (a large document arrives in parts); also how long an empty room waits before 'synced'. Default 3000. */
  syncTimeoutMs?: number;
}

/**
 * Syncs a Y.Doc and its awareness over a joined jsflow room.
 * @example
 * const room = await join({ app: 'pk_…', room: 'doc-42' });
 * const doc = new Y.Doc();
 * const provider = new JsflowProvider(room, doc);
 * provider.on('synced', () => console.log('up to date'));
 */
export class JsflowProvider {
  constructor(room: RoomLike, doc: Y.Doc, opts?: JsflowProviderOptions);
  readonly room: RoomLike;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly channel: number;
  /**
   * true once a peer's copy of the document has been applied; also once the room had no one else after syncTimeoutMs,
   * or every reachable peer was asked and none answered (none runs the provider). It never turns false again.
   */
  readonly synced: boolean;
  on(ev: 'synced', f: (synced: true) => void): this;
  off(ev: 'synced', f: (synced: true) => void): this;
  /** Removes my awareness state at the others (at once in a live page; as the page unloads, the removal goes down with it and they drop it after leaveHoldMs), stops syncing and detaches. The room stays joined: call room.leave() yourself. */
  destroy(): void;
}
