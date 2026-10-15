// Wire protocol between the game server and clients (JSON over WebSocket, plus a few HTTP routes).
import type { Appearance, GameState } from './state.js';
import type { Command } from './commands.js';
import type { Summary } from './engine.js';

export const PROTOCOL_VERSION = 1;

export interface RosterEntry {
  accountId: number; name: string; level: number; race: number; cls: number;
  online: boolean; activity: string; lastSeen: number;
}
export interface BankEntry { item: number; count: number }
export interface BankLogEntry { id: number; t: number; who: string; kind: 'deposit' | 'withdraw' | 'fill'; item: number | null; count: number; gold: number; note: string }
export interface GuildRequest { id: number; t: number; who: string; accountId: number; item: number; count: number; filled: number; note: string; open: boolean }
export interface ChatMessage { id: number; t: number; who: string; text: string }
export interface FeedItem { id: number; t: number; who: string; kind: 'level' | 'kill' | 'rank' | 'join'; text: string }

export interface GuildSnapshot {
  name: string; gold: number;
  roster: RosterEntry[]; bank: BankEntry[]; log: BankLogEntry[]; requests: GuildRequest[];
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
  | { t: 'pong'; serverTime: number };
