// The authoritative world: every character's sim state, the guild, chat and the activity feed.
// Transport-independent (the network layer subscribes to it) and driven by an injectable clock.
import {
  addItem, advance, applyCommand, emptySummary, hasItem, migrateState, newGame, OFFLINE_CAP_MS, SKILL_NAME, summarize,
  type Appearance, type BankLogEntry, type ChatMessage, type Command, type CommandResult, type FeedItem,
  applyRunRewards, dungeonLoot, roomFor, factionOfRace, groupRoles, MAX_TARGETS, nextReset, hireling, ROLE_CLASSES, ROLES, simulateRun, snapshotOf,
  type CraftOrder, type DungeonGroup, type GroupMember, type Role, type RunResult, type RunSummary, type Snapshot, type GameData, type GameState, type GuildRequest, type GuildSnapshot, type RosterEntry, type SimEvent, type Summary,
} from '@idle/sim';
import type { DB } from './db.js';

/** Absences shorter than this don't produce a "while you were away" report. */
const AWAY_REPORT_MIN_MS = 60_000;
/** The same character killing the same elite only makes the feed once per window. */
const KILL_FEED_WINDOW_MS = 30 * 60_000;
const CHAT_MAX = 300, CHAT_BURST = 5, CHAT_WINDOW_MS = 10_000;
const MAX_OPEN_REQUESTS = 10;
const MAX_OPEN_ORDERS = 10;

interface GroupRow { id: number; t: number; leader_id: number; dungeon: number; members: string; status: DungeonGroup['status']; run_id: number | null }
interface RunRow { id: number; group_id: number; dungeon: number; started: number; ends: number; snapshots: string; result: string; delivered: number }

interface OrderRow { id: number; t: number; account_id: number; recipe: number; count: number; reagents: string; tip: number; note: string; crafter_id: number | null; open: number; delivered: number }

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
  /** Who is watching which run: run id -> account id -> open viewers. */
  private watchers = new Map<number, Map<number, number>>();
  private listeners: Partial<WorldEvents>[] = [];

  constructor(private db: DB, readonly data: GameData, private clock: () => number = Date.now) {
    for (const r of db.prepare(`SELECT account_id, name, state, last_seen, away FROM characters`).all() as
      { account_id: number; name: string; state: string; last_seen: number; away: string | null }[]) {
      this.chars.set(r.account_id, {
        accountId: r.account_id, name: r.name, state: migrateState(JSON.parse(r.state), this.data), lastSeen: r.last_seen, online: 0,
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
    this.deliverRuns(now);
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

  /** Sends this account its current state again (after a command the server couldn't take). */
  resync(accountId: number): void { this.emit('state', accountId); }

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
      if (rank && rank.max > before) this.addFeed(accountId, 'rank', `${c.name} is now ${/^[AEIOU]/.test(rank.name) ? 'an' : 'a'} ${rank.name} ${SKILL_NAME[cmd.skill]}.`, now);
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
      if (roomFor(s, this.data, item) < count) return fail('Your bags are full.');
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
    if (roomFor(asker.state, this.data, req.item) < give) return fail(`${asker.name}'s bags are full.`);
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

  // ------------------------------------------------------------------ crafting orders

  createOrder(accountId: number, recipe: unknown, count: unknown, provide: unknown, tip: unknown, note: unknown): Result {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    if (!isInt(recipe, 1, 1e7) || !this.data.recipes[recipe]) return fail('Unknown recipe.');
    const r = this.data.recipes[recipe];
    if (!r.item) return fail('Enchantments go on your own gear; ask an enchanter in chat.');
    if (!isInt(count, 1, 100)) return fail('Order 1-100.');
    if (!isInt(tip, 0, 1e9)) return fail('Invalid tip.');
    const open = (this.db.prepare(`SELECT COUNT(*) n FROM craft_orders WHERE account_id = ? AND open = 1`).get(accountId) as { n: number }).n;
    if (open >= MAX_OPEN_ORDERS) return fail(`You can have ${MAX_OPEN_ORDERS} open orders.`);
    this.advanceChar(c, this.clock());
    const s = c.state;
    const reagents: [number, number][] = provide === true ? r.reagents.map(([i, n]) => [i, n * count]) : [];
    for (const [i, n] of reagents) if (!hasItem(s, i, n)) return fail(`You don't have ${n} ${this.data.items[i]?.name ?? 'reagents'}.`);
    if (s.gold < tip) return fail("You don't have that much money for the tip.");
    const text = typeof note === 'string' ? note.trim().slice(0, 80) : '';
    this.db.transaction(() => {
      for (const [i, n] of reagents) addItem(s, i, -n);
      s.gold -= tip;
      this.db.prepare(`INSERT INTO craft_orders (t, account_id, recipe, count, reagents, tip, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(this.clock(), accountId, recipe, count, JSON.stringify(reagents), tip, text);
      this.persist(c);
    })();
    this.emit('state', accountId);
    this.emit('guild');
    return OK;
  }

  private order(id: unknown): OrderRow | undefined {
    if (!isInt(id, 1, 1e12)) return undefined;
    return this.db.prepare(`SELECT * FROM craft_orders WHERE id = ?`).get(id) as OrderRow | undefined;
  }

  /** A crafter who knows the recipe takes the order and receives any reagents held for it. */
  claimOrder(accountId: number, id: unknown): Result {
    const c = this.chars.get(accountId);
    const o = this.order(id);
    if (!c) return fail('No character.');
    if (!o || !o.open) return fail('That order is no longer open.');
    if (o.crafter_id) return fail('Someone is already crafting that.');
    if (o.account_id === accountId) return fail("You can't take your own order.");
    if (!c.state.recipes.includes(o.recipe)) return fail(`You don't know ${this.data.recipes[o.recipe]?.name ?? 'that recipe'}.`);
    this.advanceChar(c, this.clock());
    this.db.transaction(() => {
      for (const [i, n] of JSON.parse(o.reagents) as [number, number][]) addItem(c.state, i, n);
      this.db.prepare(`UPDATE craft_orders SET crafter_id = ? WHERE id = ?`).run(accountId, o.id);
      this.persist(c);
    })();
    this.emit('state', accountId);
    this.emit('guild');
    return OK;
  }

  /** The crafter hands over the finished items and collects the tip. */
  deliverOrder(accountId: number, id: unknown): Result {
    const crafter = this.chars.get(accountId);
    const o = this.order(id);
    if (!crafter) return fail('No character.');
    if (!o || !o.open) return fail('That order is no longer open.');
    if (o.crafter_id !== accountId) return fail("That order isn't yours to deliver.");
    const buyer = this.chars.get(o.account_id);
    if (!buyer) return fail('That member has no character.');
    const r = this.data.recipes[o.recipe];
    const items = r.count * o.count;
    const now = this.clock();
    this.advanceChar(crafter, now);
    this.advanceChar(buyer, now);
    if (!hasItem(crafter.state, r.item, items)) return fail(`You need ${items} ${this.data.items[r.item]?.name} to deliver.`);
    if (roomFor(buyer.state, this.data, r.item) < items) return fail(`${buyer.name}'s bags are full.`);
    this.db.transaction(() => {
      addItem(crafter.state, r.item, -items);
      addItem(buyer.state, r.item, items);
      crafter.state.gold += o.tip;
      this.db.prepare(`UPDATE craft_orders SET open = 0, delivered = 1 WHERE id = ?`).run(o.id);
      this.bankLog(accountId, 'order', r.item, items, o.tip, `crafted for ${buyer.name}`);
      this.persist(crafter);
      this.persist(buyer);
    })();
    this.emit('state', accountId);
    this.emit('state', buyer.accountId);
    this.emit('guild');
    return OK;
  }

  /**
   * The buyer cancels an unclaimed order (reagents and tip come back), or the crafter gives up a
   * claimed one (handing the reagents back so the order is open again).
   */
  cancelOrder(accountId: number, id: unknown): Result {
    const o = this.order(id);
    if (!o || !o.open) return fail('That order is no longer open.');
    const reagents = JSON.parse(o.reagents) as [number, number][];
    if (o.crafter_id === accountId) {
      const crafter = this.chars.get(accountId)!;
      this.advanceChar(crafter, this.clock());
      for (const [i, n] of reagents) if (!hasItem(crafter.state, i, n)) return fail(`Return the ${n} ${this.data.items[i]?.name} first.`);
      this.db.transaction(() => {
        for (const [i, n] of reagents) addItem(crafter.state, i, -n);
        this.db.prepare(`UPDATE craft_orders SET crafter_id = NULL WHERE id = ?`).run(o.id);
        this.persist(crafter);
      })();
      this.emit('state', accountId);
    } else if (o.account_id === accountId) {
      if (o.crafter_id) return fail('A crafter is already working on it.');
      const buyer = this.chars.get(accountId)!;
      this.advanceChar(buyer, this.clock());
      this.db.transaction(() => {
        for (const [i, n] of reagents) addItem(buyer.state, i, n);
        buyer.state.gold += o.tip;
        this.db.prepare(`UPDATE craft_orders SET open = 0 WHERE id = ?`).run(o.id);
        this.persist(buyer);
      })();
      this.emit('state', accountId);
    } else return fail("That order isn't yours.");
    this.emit('guild');
    return OK;
  }

  // ------------------------------------------------------------------ dungeons: sign-ups, runs, rewards

  private group(id: unknown): GroupRow | undefined {
    if (!isInt(id, 1, 1e12)) return undefined;
    return this.db.prepare(`SELECT * FROM dungeon_groups WHERE id = ?`).get(id) as GroupRow | undefined;
  }

  /** Can this character take this role in this dungeon right now? */
  private signUpError(c: Char, dungeon: number, role: unknown): string | null {
    const d = this.data.dungeons?.[dungeon];
    if (!d) return 'Unknown dungeon.';
    if (!ROLES.includes(role as Role)) return 'Pick a role.';
    if (!ROLE_CLASSES[role as Role].includes(c.state.char.cls)) return `${this.data.classes.find(x => x.id === c.state.char.cls)?.name ?? 'Your class'}s can't ${role === 'tank' ? 'tank' : 'heal'}.`;
    if (c.state.char.level < d.minLevel) return `Requires level ${d.minLevel}.`;
    if (c.state.action?.kind === 'dungeon') return "You're already in a dungeon.";
    const locked = this.lockedUntil(c.accountId, dungeon);
    if (locked) return `You're saved to ${d.name} until it resets (${new Date(locked).toUTCString().slice(0, 22)} UTC).`;
    const open = (this.db.prepare(`SELECT members FROM dungeon_groups WHERE status = 'open'`).all() as { members: string }[])
      .some(g => (JSON.parse(g.members) as GroupMember[]).some(m => m.accountId === c.accountId));
    if (open) return "You're already signed up for a group.";
    return null;
  }

  /** When this character's raid lockout ends (0: not saved). */
  private lockedUntil(accountId: number, dungeon: number): number {
    const r = this.db.prepare(`SELECT until FROM raid_lockouts WHERE account_id = ? AND dungeon = ?`).get(accountId, dungeon) as { until: number } | undefined;
    return r && r.until > this.clock() ? r.until : 0;
  }

  /** Valid loot targets: at most two distinct items that a boss of this dungeon drops. */
  private cleanTargets(dungeon: number, targets: unknown): number[] | string {
    if (targets == null) return [];
    if (!Array.isArray(targets) || targets.length > MAX_TARGETS || !targets.every(t => isInt(t, 1, 1e9))) return `Pick up to ${MAX_TARGETS} items.`;
    const d = this.data.dungeons[dungeon];
    const drops = new Set([...dungeonLoot(this.data, d).values()].flat());
    if (!targets.every(t => drops.has(t))) return `That item doesn't drop in ${d.name}.`;
    return [...new Set(targets as number[])];
  }

  private member(c: Char, role: Role, targets: number[]): GroupMember {
    return { accountId: c.accountId, name: c.name, role, level: c.state.char.level, cls: c.state.char.cls, ...(targets.length ? { targets } : {}) };
  }

  createGroup(accountId: number, dungeon: unknown, role: unknown, targets?: unknown): Result {
    const c = this.chars.get(accountId);
    if (!c) return fail('No character.');
    if (!isInt(dungeon, 1, 1e9)) return fail('Unknown dungeon.');
    const err = this.signUpError(c, dungeon, role);
    if (err) return fail(err);
    const t = this.cleanTargets(dungeon, targets);
    if (typeof t === 'string') return fail(t);
    this.db.prepare(`INSERT INTO dungeon_groups (t, leader_id, dungeon, members) VALUES (?, ?, ?, ?)`)
      .run(this.clock(), accountId, dungeon, JSON.stringify([this.member(c, role as Role, t)]));
    this.emit('guild');
    return OK;
  }

  joinGroup(accountId: number, groupId: unknown, role: unknown, targets?: unknown): Result {
    const c = this.chars.get(accountId);
    const g = this.group(groupId);
    if (!c) return fail('No character.');
    if (!g || g.status !== 'open') return fail('That group is no longer forming.');
    const err = this.signUpError(c, g.dungeon, role);
    if (err) return fail(err);
    const members = JSON.parse(g.members) as GroupMember[];
    if (members.length >= (this.data.dungeons[g.dungeon]?.size ?? 5)) return fail('That group is full.');
    const t = this.cleanTargets(g.dungeon, targets);
    if (typeof t === 'string') return fail(t);
    members.push(this.member(c, role as Role, t));
    this.db.prepare(`UPDATE dungeon_groups SET members = ? WHERE id = ?`).run(JSON.stringify(members), g.id);
    this.emit('guild');
    return OK;
  }

  /** Change your loot targets while the group is still forming. */
  setTargets(accountId: number, groupId: unknown, targets: unknown): Result {
    const g = this.group(groupId);
    if (!g || g.status !== 'open') return fail('That group is no longer forming.');
    const members = JSON.parse(g.members) as GroupMember[];
    const m = members.find(x => x.accountId === accountId);
    if (!m) return fail("You're not in that group.");
    const t = this.cleanTargets(g.dungeon, targets);
    if (typeof t === 'string') return fail(t);
    if (t.length) m.targets = t; else delete m.targets;
    this.db.prepare(`UPDATE dungeon_groups SET members = ? WHERE id = ?`).run(JSON.stringify(members), g.id);
    this.emit('guild');
    return OK;
  }

  leaveGroup(accountId: number, groupId: unknown): Result {
    const g = this.group(groupId);
    if (!g || g.status !== 'open') return fail('That group is no longer forming.');
    const members = (JSON.parse(g.members) as GroupMember[]).filter(m => m.accountId !== accountId);
    if (g.leader_id === accountId || !members.length) this.db.prepare(`UPDATE dungeon_groups SET status = 'cancelled' WHERE id = ?`).run(g.id);
    else this.db.prepare(`UPDATE dungeon_groups SET members = ? WHERE id = ?`).run(JSON.stringify(members), g.id);
    this.emit('guild');
    return OK;
  }

  /**
   * The leader starts the run: everyone's snapshot is taken now, hirelings fill the empty slots (a tank
   * and a healer first), the run is simulated, and every member is busy in the dungeon until it ends.
   */
  startGroup(accountId: number, groupId: unknown, seed = Math.floor(Math.random() * 2 ** 31)): Result {
    const g = this.group(groupId);
    if (!g || g.status !== 'open') return fail('That group is no longer forming.');
    if (g.leader_id !== accountId) return fail('Only the group leader can start the run.');
    const d = this.data.dungeons[g.dungeon];
    if (!d) return fail('Unknown dungeon.');
    const now = this.clock();
    const members = JSON.parse(g.members) as GroupMember[];
    const snaps: Snapshot[] = [];
    for (const m of members) {
      const c = this.chars.get(m.accountId);
      if (!c) return fail(`${m.name} has no character.`);
      this.advanceChar(c, now);
      if (c.state.now < now) c.state.now = now; // paused beyond the offline window: resume now
      if (c.state.action?.kind === 'dungeon') return fail(`${m.name} is already in a dungeon.`);
      if (c.state.phase.p === 'dead') return fail(`${m.name} is dead.`);
      if (d.raid && this.lockedUntil(c.accountId, g.dungeon)) return fail(`${m.name} is saved to ${d.name}.`);
      const target = Math.min(c.state.char.level, d.maxLevel);
      snaps.push(snapshotOf(c.state, this.data, c.accountId, m.role, Math.max(d.minLevel, target), { targets: m.targets, consumables: true }));
    }
    const level = Math.round(snaps.reduce((a, s) => a + s.level, 0) / snaps.length);
    const side = factionOfRace(this.data, this.chars.get(g.leader_id)!.state.char.race);
    const need: Role[] = [];
    const has = (r: Role) => snaps.filter(s => s.role === r).length + need.filter(x => x === r).length;
    const { tanks, healers } = groupRoles(d.size);
    while (has('tank') < tanks && snaps.length + need.length < d.size) need.push('tank');
    while (has('healer') < healers && snaps.length + need.length < d.size) need.push('healer');
    while (snaps.length + need.length < d.size) need.push('dps');
    need.forEach((r, i) => snaps.push(hireling(this.data, r, level, side, i, d.tier ?? 0)));
    const result = simulateRun(this.data, d, snaps, seed >>> 0);
    const ends = now + result.durationMs;
    this.db.transaction(() => {
      const runId = Number(this.db.prepare(`INSERT INTO dungeon_runs (group_id, dungeon, started, ends, snapshots, result) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(g.id, g.dungeon, now, ends, JSON.stringify(snaps), JSON.stringify(result)).lastInsertRowid);
      this.db.prepare(`UPDATE dungeon_groups SET status = 'running', run_id = ? WHERE id = ?`).run(runId, g.id);
      members.forEach((m, i) => {
        const c = this.chars.get(m.accountId)!;
        // Elixirs are drunk as the run starts (potions are counted when it ends, as they were used).
        for (const e of snaps[i].elixirs ?? []) addItem(c.state, e, -1);
        // Entering a raid saves you to it until its next reset.
        if (d.raid) this.db.prepare(`INSERT OR REPLACE INTO raid_lockouts (account_id, dungeon, until) VALUES (?, ?, ?)`).run(m.accountId, g.dungeon, nextReset(d, now));
        c.state.action = { kind: 'dungeon', run: runId, dungeon: g.dungeon, until: ends };
        c.state.phase = { p: 'work', from: now, until: ends };
        this.persist(c);
      });
    })();
    for (const m of members) this.emit('state', m.accountId);
    this.addFeed(accountId, 'dungeon', `${this.chars.get(accountId)!.name}'s group entered ${d.name}. Watch them live on the Dungeons page!`, now);
    this.emit('guild');
    return OK;
  }

  /** Hand out the rewards of runs that have ended. */
  private deliverRuns(now: number): void {
    const due = this.db.prepare(`SELECT * FROM dungeon_runs WHERE delivered = 0 AND ends <= ?`).all(now) as RunRow[];
    for (const run of due) {
      const result = JSON.parse(run.result) as RunResult;
      const snaps = JSON.parse(run.snapshots) as Snapshot[];
      const players = snaps.filter(s => !s.hireling).length;
      this.db.transaction(() => {
        snaps.forEach((s, i) => {
          if (s.hireling || s.accountId == null) return;
          const c = this.chars.get(s.accountId);
          if (!c) return;
          this.advanceChar(c, now);
          applyRunRewards(c.state, this.data, result, i, players);
          this.persist(c);
        });
        this.db.prepare(`UPDATE dungeon_runs SET delivered = 1 WHERE id = ?`).run(run.id);
        this.db.prepare(`UPDATE dungeon_groups SET status = 'done' WHERE id = ?`).run(run.group_id);
      })();
      const leader = snaps.find(s => !s.hireling)?.name ?? 'A group';
      const name = this.data.dungeons[run.dungeon]?.name ?? 'a dungeon';
      if (result.cleared) this.addFeed(snaps.find(s => !s.hireling)?.accountId ?? 0, 'dungeon', `${leader}'s group cleared ${name}!`, now);
      for (const s of snaps) if (s.accountId != null && !s.hireling) this.emit('state', s.accountId);
      this.emit('guild');
    }
  }

  /** A connection starts or stops watching a run (null stops). */
  watch(accountId: number, run: number | null, prev: number | null): void {
    if (prev != null) {
      const m = this.watchers.get(prev);
      const n = (m?.get(accountId) ?? 0) - 1;
      if (m) { if (n > 0) m.set(accountId, n); else m.delete(accountId); if (!m.size) this.watchers.delete(prev); }
    }
    if (run != null && isInt(run, 1, 1e12)) {
      const m = this.watchers.get(run) ?? this.watchers.set(run, new Map()).get(run)!;
      m.set(accountId, (m.get(accountId) ?? 0) + 1);
    }
    this.emit('guild');
  }

  /** A run's full result and snapshots, for the replay. */
  replay(runId: unknown): { run: RunResult; snapshots: Snapshot[] } | null {
    if (!isInt(runId, 1, 1e12)) return null;
    const r = this.db.prepare(`SELECT * FROM dungeon_runs WHERE id = ?`).get(runId) as RunRow | undefined;
    return r ? { run: JSON.parse(r.result), snapshots: JSON.parse(r.snapshots) } : null;
  }

  private groupsSnapshot(nameOf: (id: number) => string): DungeonGroup[] {
    const rows = this.db.prepare(`SELECT * FROM dungeon_groups WHERE status IN ('open', 'running') OR t > ? ORDER BY id DESC LIMIT 30`)
      .all(this.clock() - 3 * 86_400_000) as GroupRow[];
    return rows.filter(r => r.status !== 'cancelled').map(r => {
      const run = r.run_id ? this.db.prepare(`SELECT id, started, ends, snapshots, result FROM dungeon_runs WHERE id = ?`).get(r.run_id) as RunRow | undefined : undefined;
      let summary: RunSummary | undefined;
      if (run) {
        const res = JSON.parse(run.result) as RunResult, snaps = JSON.parse(run.snapshots) as Snapshot[];
        const done = run.ends <= this.clock();
        summary = {
          id: run.id, started: run.started, ends: run.ends, total: this.data.dungeons[r.dungeon]?.encounters.length ?? 0,
          // The outcome stays hidden until the run is over (watch the replay as it happens).
          cleared: done && res.cleared, progress: done ? res.progress : 0,
          members: snaps.map(s => ({ name: s.name, role: s.role, hireling: !!s.hireling, cls: s.cls })),
          loot: done ? res.loot.map(l => ({ item: l.item, winner: l.winner == null ? null : snaps[l.winner]?.name ?? null })) : [],
          watching: [...(this.watchers.get(run.id)?.keys() ?? [])].map(nameOf),
        };
      }
      return { id: r.id, t: r.t, dungeon: r.dungeon, leaderId: r.leader_id, leader: nameOf(r.leader_id), members: JSON.parse(r.members), status: r.status, ...(summary ? { run: summary } : {}) };
    });
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
      groups: this.groupsSnapshot(nameOf),
      lockouts: (this.db.prepare(`SELECT * FROM raid_lockouts WHERE until > ?`).all(this.clock()) as { account_id: number; dungeon: number; until: number }[])
        .map(r => ({ accountId: r.account_id, name: nameOf(r.account_id), dungeon: r.dungeon, until: r.until })),
      orders: (this.db.prepare(`SELECT * FROM craft_orders WHERE open = 1 OR t > ? ORDER BY open DESC, id DESC LIMIT 40`).all(this.clock() - 3 * 86_400_000) as OrderRow[])
        .map((r): CraftOrder => ({
          id: r.id, t: r.t, who: nameOf(r.account_id), accountId: r.account_id, recipe: r.recipe, count: r.count,
          reagents: JSON.parse(r.reagents), tip: r.tip, note: r.note,
          crafter: r.crafter_id ? nameOf(r.crafter_id) : null, crafterId: r.crafter_id, open: !!r.open, delivered: !!r.delivered,
        })),
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
    case 'craft': { const r = data.recipes[a.recipe]; return r ? `${r.skill === 'cooking' ? 'Cooking' : 'Crafting'} ${r.name}` : 'Crafting'; }
    case 'travel': return `Travelling to ${data.zones.find(z => z.id === a.to)?.name ?? 'somewhere'}`;
    case 'quest': return `Questing: ${data.quests[a.quest]?.name ?? 'a quest'}`;
    case 'dungeon': return `In ${data.dungeons?.[a.dungeon]?.name ?? 'a dungeon'}`;
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
