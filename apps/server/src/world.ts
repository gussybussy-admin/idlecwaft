// The authoritative world: every character's sim state, the guild, chat and the activity feed.
// Transport-independent (the network layer subscribes to it) and driven by an injectable clock.
import {
  addItem, advance, applyCommand, emptySummary, hasItem, migrateState, newGame, OFFLINE_CAP_MS, summarize,
  type Appearance, type BankLogEntry, type ChatMessage, type Command, type CommandResult, type FeedItem,
  type GameData, type GameState, type GuildRequest, type GuildSnapshot, type RosterEntry, type SimEvent, type Summary,
} from '@idle/sim';
import type { DB } from './db.js';

/** Absences shorter than this don't produce a "while you were away" report. */
const AWAY_REPORT_MIN_MS = 60_000;
/** The same character killing the same elite only makes the feed once per window. */
const KILL_FEED_WINDOW_MS = 30 * 60_000;
const CHAT_MAX = 300, CHAT_BURST = 5, CHAT_WINDOW_MS = 10_000;
const MAX_OPEN_REQUESTS = 10;

interface Char {
  accountId: number;
  name: string;
  state: GameState;
  lastSeen: number;
  online: number;          // open connections
  away: Summary | null;    // progress accumulated while offline
  dirty: boolean;
  chatTimes: number[];
  lastKillFeed: Map<number, number>;
}

export interface WorldEvents {
  state(accountId: number): void;            // a character's state changed outside the normal tick (command, trade)
  guild(): void;                             // roster/bank/requests changed
  chat(msg: ChatMessage): void;
  feed(item: FeedItem): void;
}

export type Result = { ok: true } | { ok: false; error: string };
const fail = (error: string): Result => ({ ok: false, error });
const OK: Result = { ok: true };
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export class World {
  private chars = new Map<number, Char>();
  private listeners: Partial<WorldEvents>[] = [];

  constructor(private db: DB, readonly data: GameData, private clock: () => number = Date.now) {
    for (const r of db.prepare(`SELECT account_id, name, state, last_seen, away FROM characters`).all() as
      { account_id: number; name: string; state: string; last_seen: number; away: string | null }[]) {
      this.chars.set(r.account_id, {
        accountId: r.account_id, name: r.name, state: migrateState(JSON.parse(r.state)), lastSeen: r.last_seen, online: 0,
        away: r.away ? JSON.parse(r.away) : null, dirty: false, chatTimes: [], lastKillFeed: new Map(),
      });
    }
  }

  on(l: Partial<WorldEvents>): () => void {
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter(x => x !== l); };
  }
  private emit<K extends keyof WorldEvents>(k: K, ...args: Parameters<WorldEvents[K]>): void {
    for (const l of this.listeners) (l[k] as ((...a: Parameters<WorldEvents[K]>) => void) | undefined)?.(...args);
  }

  // ------------------------------------------------------------------ simulation

  /** How far a character may be simulated: live while online, up to 24h after last seen while offline. */
  private horizon(c: Char, now: number): number {
    return c.online > 0 ? now : Math.min(now, c.lastSeen + OFFLINE_CAP_MS);
  }

  private advanceChar(c: Char, now: number): void {
    const to = this.horizon(c, now);
    if (to <= c.state.now) return;
    const from = c.state.now;
    const offline = c.online === 0;
    const sum = offline ? (c.away ??= emptySummary()) : null;
    const collect = sum ? summarize(sum) : null;
    advance(c.state, this.data, to, e => { collect?.(e); this.onSimEvent(c, e); });
    if (sum) sum.ms += to - from;
    c.dirty = true;
  }

  /** Advance every character to its horizon. Called once a second by the server. */
  tick(): void {
    const now = this.clock();
    for (const c of this.chars.values()) this.advanceChar(c, now);
  }

  private onSimEvent(c: Char, e: SimEvent): void {
    if (e.type === 'levelup' && e.level % 10 === 0) {
      this.addFeed(c.accountId, 'level', `${c.name} reached level ${e.level}!`, e.t);
    } else if (e.type === 'kill') {
      const def = this.data.creatures[e.creature];
      if (!def || def.rank === 0) return;
      const last = c.lastKillFeed.get(def.id) ?? -Infinity;
      if (e.t - last < KILL_FEED_WINDOW_MS) return;
      c.lastKillFeed.set(def.id, e.t);
      const kind = def.rank === 2 || def.rank === 4 ? 'the rare' : def.rank === 3 ? 'the boss' : 'the elite';
      this.addFeed(c.accountId, 'kill', `${c.name} defeated ${kind} ${def.name}.`, e.t);
    }
  }

  // ------------------------------------------------------------------ sessions

  hasCharacter(accountId: number): boolean { return this.chars.has(accountId); }

  /** A client connected. Returns the offline report to show, if any. */
  connect(accountId: number): Summary | null {
    const c = this.chars.get(accountId);
    if (!c) return null;
    const now = this.clock();
    this.advanceChar(c, now); // finish the offline window first, while still counted as offline
    // Beyond the 24h window the character was paused: resume from now instead of simulating the gap.
    if (c.online === 0 && c.state.now < now) c.state.now = now;
    c.online++;
    c.lastSeen = now;
    c.dirty = true;
    this.emit('guild');
    const away = c.away && c.away.ms >= AWAY_REPORT_MIN_MS ? c.away : null;
    c.away = null;
    return away;
  }

  disconnect(accountId: number): void {
    const c = this.chars.get(accountId);
    if (!c) return;
    const now = this.clock();
    this.advanceChar(c, now);
    c.online = Math.max(0, c.online - 1);
    c.lastSeen = now;
    c.dirty = true;
    this.emit('guild');
  }

  /** Current state of a character, advanced to now. */
  stateOf(accountId: number): GameState | null {
    const c = this.chars.get(accountId);
    if (!c) return null;
    this.advanceChar(c, this.clock());
    return c.state;
  }

  createCharacter(accountId: number, name: unknown, race: unknown, cls: unknown, look?: Appearance): Result {
    if (this.chars.has(accountId)) return fail('You already have a character.');
    if (typeof name !== 'string' || !/^[A-Za-z]{2,12}$/.test(name)) return fail('Names are 2-12 letters.');
    const proper = name[0].toUpperCase() + name.slice(1).toLowerCase();
    if (this.db.prepare(`SELECT 1 FROM characters WHERE name = ?`).get(proper)) return fail('That name is taken.');
    if (!isInt(race, 1, 8) || !isInt(cls, 1, 11) || !this.data.raceClasses[race]?.includes(cls)) return fail('Invalid race/class.');
    const now = this.clock();
    const cleanLook = look && [look.sex, look.skin, look.face, look.hairStyle, look.hairColor, look.facialHair].every(v => isInt(v, 0, 64)) && look.sex <= 1
      ? { sex: look.sex, skin: look.skin, face: look.face, hairStyle: look.hairStyle, hairColor: look.hairColor, facialHair: look.facialHair } : undefined;
    const state = newGame(this.data, { name: proper, race, cls, look: cleanLook, seed: (Math.random() * 2 ** 32) >>> 0, now });
    this.db.prepare(`INSERT INTO characters (account_id, name, state, last_seen) VALUES (?, ?, ?, ?)`).run(accountId, proper, JSON.stringify(state), now);
    this.chars.set(accountId, { accountId, name: proper, state, lastSeen: now, online: 0, away: null, dirty: false, chatTimes: [], lastKillFeed: new Map() });
    this.addFeed(accountId, 'join', `${proper} joined the guild.`, now);
    this.emit('guild');
    return OK;
  }

  // ------------------------------------------------------------------ commands

  command(accountId: number, cmd: Command): CommandResult {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    const now = this.clock();
    this.advanceChar(c, now);
    const before = cmd.name === 'train' ? c.state.skills[cmd.skill].max : 0;
    const r = applyCommand(c.state, this.data, cmd);
    c.dirty = true;
    if (r.ok && cmd.name === 'train') {
      const rank = this.data.skillRanks[cmd.skill].find(x => x.max === c.state.skills[cmd.skill].max);
      if (rank && rank.max > before) this.addFeed(accountId, 'rank', `${c.name} is now ${/^[AEIOU]/.test(rank.name) ? 'an' : 'a'} ${rank.name} ${cap(cmd.skill)}.`, now);
    }
    this.emit('state', accountId);
    this.emit('guild');
    return r;
  }

  // ------------------------------------------------------------------ guild bank

  deposit(accountId: number, item: unknown, count: unknown, gold: unknown): Result {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    this.advanceChar(c, this.clock());
    const s = c.state;
    if (gold !== undefined) {
      if (!isInt(gold, 1, 1e9) || gold > s.gold) return fail("You don't have that much money.");
      this.db.transaction(() => {
        s.gold -= gold;
        this.db.prepare(`UPDATE guild SET gold = gold + ? WHERE id = 1`).run(gold);
        this.bankLog(accountId, 'deposit', null, 0, gold, '');
        this.persist(c);
      })();
    } else {
      if (!isInt(item, 1, 1e7) || !isInt(count, 1, 1e6) || !this.data.items[item]) return fail('Invalid item.');
      if (!hasItem(s, item, count)) return fail("You don't have that many.");
      this.db.transaction(() => {
        addItem(s, item, -count);
        this.db.prepare(`INSERT INTO guild_bank (item, count) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET count = count + excluded.count`).run(item, count);
        this.bankLog(accountId, 'deposit', item, count, 0, '');
        this.persist(c);
      })();
    }
    this.emit('state', accountId);
    this.emit('guild');
    return OK;
  }

  withdraw(accountId: number, item: unknown, count: unknown, gold: unknown): Result {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    this.advanceChar(c, this.clock());
    const s = c.state;
    if (gold !== undefined) {
      const bankGold = (this.db.prepare(`SELECT gold FROM guild WHERE id = 1`).get() as { gold: number }).gold;
      if (!isInt(gold, 1, 1e9) || gold > bankGold) return fail('The guild bank does not have that much money.');
      this.db.transaction(() => {
        this.db.prepare(`UPDATE guild SET gold = gold - ? WHERE id = 1`).run(gold);
        s.gold += gold;
        this.bankLog(accountId, 'withdraw', null, 0, gold, '');
        this.persist(c);
      })();
    } else {
      if (!isInt(item, 1, 1e7) || !isInt(count, 1, 1e6)) return fail('Invalid item.');
      const row = this.db.prepare(`SELECT count FROM guild_bank WHERE item = ?`).get(item) as { count: number } | undefined;
      if (!row || row.count < count) return fail('The guild bank does not have that many.');
      this.db.transaction(() => {
        if (row.count === count) this.db.prepare(`DELETE FROM guild_bank WHERE item = ?`).run(item);
        else this.db.prepare(`UPDATE guild_bank SET count = count - ? WHERE item = ?`).run(count, item);
        addItem(s, item, count);
        this.bankLog(accountId, 'withdraw', item, count, 0, '');
        this.persist(c);
      })();
    }
    this.emit('state', accountId);
    this.emit('guild');
    return OK;
  }

  // ------------------------------------------------------------------ requests ("need 20 Copper Bars")

  createRequest(accountId: number, item: unknown, count: unknown, note: unknown): Result {
    if (!this.chars.has(accountId)) return fail('No character.');
    if (!isInt(item, 1, 1e7) || !this.data.items[item]) return fail('Unknown item.');
    if (!isInt(count, 1, 1000)) return fail('Ask for 1-1000.');
    const open = (this.db.prepare(`SELECT COUNT(*) n FROM guild_requests WHERE account_id = ? AND open = 1`).get(accountId) as { n: number }).n;
    if (open >= MAX_OPEN_REQUESTS) return fail(`You can have ${MAX_OPEN_REQUESTS} open requests.`);
    const text = typeof note === 'string' ? note.trim().slice(0, 80) : '';
    this.db.prepare(`INSERT INTO guild_requests (t, account_id, item, count, note) VALUES (?, ?, ?, ?, ?)`).run(this.clock(), accountId, item, count, text);
    this.emit('guild');
    return OK;
  }

  /** The filler hands items straight to the requester (logged in the bank log). */
  fillRequest(accountId: number, requestId: unknown, count: unknown): Result {
    const filler = this.chars.get(accountId);
    if (!filler) return fail('No character.');
    if (!isInt(requestId, 1, 1e12) || !isInt(count, 1, 1000)) return fail('Invalid request.');
    const req = this.db.prepare(`SELECT * FROM guild_requests WHERE id = ? AND open = 1`).get(requestId) as
      { id: number; account_id: number; item: number; count: number; filled: number } | undefined;
    if (!req) return fail('That request is no longer open.');
    if (req.account_id === accountId) return fail("You can't fill your own request.");
    const asker = this.chars.get(req.account_id);
    if (!asker) return fail('That member has no character.');
    const now = this.clock();
    this.advanceChar(filler, now);
    this.advanceChar(asker, now);
    const give = Math.min(count, req.count - req.filled);
    if (!hasItem(filler.state, req.item, give)) return fail("You don't have that many.");
    this.db.transaction(() => {
      addItem(filler.state, req.item, -give);
      addItem(asker.state, req.item, give);
      const filled = req.filled + give;
      this.db.prepare(`UPDATE guild_requests SET filled = ?, open = ? WHERE id = ?`).run(filled, filled < req.count ? 1 : 0, req.id);
      this.bankLog(accountId, 'fill', req.item, give, 0, `for ${asker.name}`);
      this.persist(filler);
      this.persist(asker);
    })();
    this.emit('state', accountId);
    this.emit('state', asker.accountId);
    this.emit('guild');
    return OK;
  }

  cancelRequest(accountId: number, requestId: unknown): Result {
    if (!isInt(requestId, 1, 1e12)) return fail('Invalid request.');
    const r = this.db.prepare(`UPDATE guild_requests SET open = 0 WHERE id = ? AND account_id = ? AND open = 1`).run(requestId, accountId);
    if (!r.changes) return fail('That request is not yours or already closed.');
    this.emit('guild');
    return OK;
  }

  // ------------------------------------------------------------------ chat + feed

  chat(accountId: number, text: unknown): Result {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    if (typeof text !== 'string') return fail('Empty message.');
    const msg = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!msg) return fail('Empty message.');
    const now = this.clock();
    c.chatTimes = c.chatTimes.filter(t => now - t < CHAT_WINDOW_MS);
    if (c.chatTimes.length >= CHAT_BURST) return fail('Slow down a little.');
    c.chatTimes.push(now);
    const id = Number(this.db.prepare(`INSERT INTO chat (t, account_id, text) VALUES (?, ?, ?)`).run(now, accountId, msg).lastInsertRowid);
    this.emit('chat', { id, t: now, who: c.name, text: msg });
    return OK;
  }

  private addFeed(accountId: number, kind: FeedItem['kind'], text: string, t: number): void {
    const who = this.chars.get(accountId)?.name ?? '?';
    const id = Number(this.db.prepare(`INSERT INTO feed (t, account_id, kind, text) VALUES (?, ?, ?, ?)`).run(t, accountId, kind, text).lastInsertRowid);
    this.emit('feed', { id, t, who, kind, text });
  }

  private bankLog(accountId: number, kind: BankLogEntry['kind'], item: number | null, count: number, gold: number, note: string): void {
    this.db.prepare(`INSERT INTO guild_log (t, account_id, kind, item, count, gold, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(this.clock(), accountId, kind, item, count, gold, note);
  }

  // ------------------------------------------------------------------ snapshots + persistence

  guildSnapshot(): GuildSnapshot {
    const g = this.db.prepare(`SELECT name, gold FROM guild WHERE id = 1`).get() as { name: string; gold: number };
    const nameOf = (id: number) => this.chars.get(id)?.name ?? '?';
    const roster: RosterEntry[] = [...this.chars.values()].map(c => ({
      accountId: c.accountId, name: c.name, level: c.state.char.level, race: c.state.char.race, cls: c.state.char.cls,
      online: c.online > 0, activity: activityText(c.state, this.data), lastSeen: c.lastSeen,
    })).sort((a, b) => Number(b.online) - Number(a.online) || b.level - a.level || a.name.localeCompare(b.name));
    return {
      name: g.name, gold: g.gold, roster,
      bank: this.db.prepare(`SELECT item, count FROM guild_bank ORDER BY item`).all() as GuildSnapshot['bank'],
      log: (this.db.prepare(`SELECT * FROM guild_log ORDER BY id DESC LIMIT 40`).all() as
        { id: number; t: number; account_id: number; kind: BankLogEntry['kind']; item: number | null; count: number; gold: number; note: string }[])
        .map(r => ({ id: r.id, t: r.t, who: nameOf(r.account_id), kind: r.kind, item: r.item, count: r.count, gold: r.gold, note: r.note })),
      requests: (this.db.prepare(`SELECT * FROM guild_requests WHERE open = 1 OR t > ? ORDER BY open DESC, id DESC LIMIT 40`).all(this.clock() - 3 * 86_400_000) as
        { id: number; t: number; account_id: number; item: number; count: number; filled: number; note: string; open: number }[])
        .map((r): GuildRequest => ({ id: r.id, t: r.t, who: nameOf(r.account_id), accountId: r.account_id, item: r.item, count: r.count, filled: r.filled, note: r.note, open: !!r.open })),
      chat: (this.db.prepare(`SELECT * FROM chat ORDER BY id DESC LIMIT 60`).all() as { id: number; t: number; account_id: number; text: string }[])
        .reverse().map(r => ({ id: r.id, t: r.t, who: nameOf(r.account_id), text: r.text })),
      feed: (this.db.prepare(`SELECT * FROM feed ORDER BY id DESC LIMIT 40`).all() as { id: number; t: number; account_id: number; kind: FeedItem['kind']; text: string }[])
        .map(r => ({ id: r.id, t: r.t, who: nameOf(r.account_id), kind: r.kind, text: r.text })),
    };
  }

  private persist(c: Char): void {
    this.db.prepare(`UPDATE characters SET state = ?, last_seen = ?, away = ? WHERE account_id = ?`)
      .run(JSON.stringify(c.state), c.lastSeen, c.away ? JSON.stringify(c.away) : null, c.accountId);
    c.dirty = false;
  }

  /** Write every changed character to disk. */
  save(): void {
    this.db.transaction(() => { for (const c of this.chars.values()) if (c.dirty) this.persist(c); })();
  }

  isOnline(accountId: number): boolean { return (this.chars.get(accountId)?.online ?? 0) > 0; }
}

export function activityText(s: GameState, data: GameData): string {
  if (s.phase.p === 'dead') return 'Dead';
  const a = s.action;
  if (!a) return 'Idle';
  switch (a.kind) {
    case 'fight': return `Fighting ${data.creatures[a.creature]?.name ?? 'monsters'}`;
    case 'gather': { const n = data.nodes[a.node]; return n ? `${n.skill === 'mining' ? 'Mining' : 'Gathering'} ${n.name}` : 'Gathering'; }
    case 'fish': return 'Fishing';
    case 'cook': return `Cooking ${data.recipes[a.recipe]?.name ?? ''}`.trim();
    case 'travel': return `Travelling to ${data.zones.find(z => z.id === a.to)?.name ?? 'somewhere'}`;
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
