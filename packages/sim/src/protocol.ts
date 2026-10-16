// Wire protocol between the game server and clients (JSON over WebSocket, plus a few HTTP routes).
import type { Appearance, GameState } from './state.js';
import type { Command } from './commands.js';
import type { Summary } from './engine.js';
import type { Role, RunResult, Snapshot } from './group.js';

export const PROTOCOL_VERSION = 1;

export interface RosterEntry {
  accountId: number; name: string; level: number; race: number; cls: number;
  online: boolean; activity: string; lastSeen: number;
}
export interface BankEntry { item: number; count: number }
export interface BankLogEntry { id: number; t: number; who: string; kind: 'deposit' | 'withdraw' | 'fill' | 'order'; item: number | null; count: number; gold: number; note: string }
export interface GuildRequest { id: number; t: number; who: string; accountId: number; item: number; count: number; filled: number; note: string; open: boolean }
/**
 * A crafting order: someone wants `count` crafts of a recipe, optionally handing over the reagents and
 * a tip up front (held by the guild until the order closes). A crafter claims it (and receives the
 * reagents), then delivers the items and collects the tip.
 */
export interface CraftOrder {
  id: number; t: number; who: string; accountId: number; recipe: number; count: number;
  reagents: [number, number][]; tip: number; note: string;
  crafter: string | null; crafterId: number | null; open: boolean; delivered: boolean;
}
/** A dungeon group being formed, running, or finished. */
export interface GroupMember { accountId: number; name: string; role: Role; level: number; cls: number }
export interface RunSummary {
  id: number; started: number; ends: number; cleared: boolean; progress: number; total: number;
  members: { name: string; role: Role; hireling: boolean; cls: number }[];
  loot: { item: number; winner: string | null }[];
  /** Guild members watching the run right now. */
  watching: string[];
}
export interface DungeonGroup {
  id: number; t: number; dungeon: number; leaderId: number; leader: string;
  members: GroupMember[]; status: 'open' | 'running' | 'done' | 'cancelled'; run?: RunSummary;
}
export interface ChatMessage { id: number; t: number; who: string; text: string }
export interface FeedItem { id: number; t: number; who: string; kind: 'level' | 'kill' | 'rank' | 'join' | 'dungeon'; text: string }

export interface GuildSnapshot {
  name: string; gold: number;
  roster: RosterEntry[]; bank: BankEntry[]; log: BankLogEntry[]; requests: GuildRequest[]; orders: CraftOrder[]; groups: DungeonGroup[];
  chat: ChatMessage[]; feed: FeedItem[];
}

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'create'; name: string; race: number; cls: number; look?: Appearance }
  | { t: 'cmd'; id: number; cmd: Command }
  | { t: 'chat'; text: string }
  | { t: 'bank'; id: number; op: 'deposit' | 'withdraw'; item?: number; count?: number; gold?: number }
  | { t: 'request'; id: number; op: 'create'; item: number; count: number; note?: string }
  | { t: 'request'; id: number; op: 'fill'; request: number; count: number }
  | { t: 'request'; id: number; op: 'cancel'; request: number }
  | { t: 'order'; id: number; op: 'create'; recipe: number; count: number; provide: boolean; tip: number; note?: string }
  | { t: 'order'; id: number; op: 'claim' | 'deliver' | 'cancel'; order: number }
  | { t: 'group'; id: number; op: 'create'; dungeon: number; role: Role }
  | { t: 'group'; id: number; op: 'join'; group: number; role: Role }
  | { t: 'group'; id: number; op: 'leave' | 'start' | 'cancel'; group: number }
  | { t: 'replay'; id: number; run: number }
  /** Which run this connection is watching (null: none), so the guild sees who's watching live. */
  | { t: 'watch'; run: number | null }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'hello'; serverTime: number; account: { id: number; username: string }; guild: GuildSnapshot; dataVersion: string }
  | { t: 'needCharacter' }
  | { t: 'state'; serverTime: number; state: GameState }
  | { t: 'away'; summary: Summary }
  | { t: 'result'; id: number; ok: boolean; error?: string }
  | { t: 'guild'; guild: GuildSnapshot }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'feed'; item: FeedItem }
  | { t: 'error'; error: string }
  | { t: 'pong'; serverTime: number }
  | { t: 'replay'; id: number; run: RunResult; snapshots: Snapshot[] };
