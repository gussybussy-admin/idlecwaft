// Class mechanics that aren't plain spells: a rogue's weapon poisons and a shaman's totems. Both are
// always kept up while idling (reapplying poisons and dropping totems is busywork), at the ranks the
// character's level gives (vanilla numbers).
import type { GameData } from './data.js';
import type { GameState } from './state.js';
import { knownSpells } from './combat.js';

export const ROGUE = 4, SHAMAN = 7;

/** Instant Poison ranks: learned at, nature damage per proc (20% of hits). */
const INSTANT: [number, number, number][] = [[20, 19, 25], [28, 30, 38], [36, 44, 56], [44, 67, 85], [52, 92, 118], [60, 112, 148]];
/** Deadly Poison ranks: learned at, damage per stack over 12 s (30% of hits; stacks to 5). */
const DEADLY: [number, number][] = [[30, 36], [38, 52], [46, 80], [54, 108], [60, 136]];
export const INSTANT_CHANCE = 20, DEADLY_CHANCE = 30, DEADLY_STACKS = 5, DEADLY_MS = 12_000;

const rankAt = <T extends unknown[]>(ranks: T[], level: number): T | null => [...ranks].reverse().find(r => (r[0] as number) <= level) ?? null;

export interface Poisons { instant?: { min: number; max: number }; deadly?: { perStack: number } }

/** The poisons on a rogue's weapons: the best rank of each poison the rogue knows (from the trainer). */
export function poisons(s: GameState, data: GameData): Poisons {
  if (s.char.cls !== ROGUE) return {};
  const known = new Set(knownSpells(s, data).map(sp => sp.name.replace(/ [IVX]+$/, '')));
  const out: Poisons = {};
  const i = known.has('Instant Poison') ? rankAt(INSTANT, s.char.level) : null;
  if (i) out.instant = { min: i[1], max: i[2] };
  const d = known.has('Deadly Poison') ? rankAt(DEADLY, s.char.level) : null;
  if (d) out.deadly = { perStack: d[1] };
  return out;
}

/** Searing Totem: learned at, fire damage per attack (every 2.5 s). */
const SEARING: [number, number, number][] = [[10, 9, 11], [20, 13, 17], [30, 19, 25], [40, 26, 34], [50, 33, 45], [60, 40, 54]];
/** Strength of Earth Totem: learned at, Strength. */
const EARTH: [number, number][] = [[10, 10], [24, 20], [38, 36], [52, 61], [60, 77]];
/** Healing Stream Totem: learned at, health every 2 s. */
const STREAM: [number, number][] = [[20, 6], [30, 8], [40, 10], [50, 12], [60, 14]];
export const SEARING_MS = 2500, STREAM_MS = 2000;

export interface Totems { searing?: { min: number; max: number }; strength: number; stream: number }

/** A shaman's totems at this level (shamans learn them from their trainer as they level). */
export function totems(s: GameState): Totems | null {
  if (s.char.cls !== SHAMAN) return null;
  const sr = rankAt(SEARING, s.char.level), e = rankAt(EARTH, s.char.level), h = rankAt(STREAM, s.char.level);
  return { ...(sr ? { searing: { min: sr[1], max: sr[2] } } : {}), strength: e?.[1] ?? 0, stream: h?.[1] ?? 0 };
}

/** Names for the damage and healing of poisons and totems (they are not class spells in the data). */
export const EFFECT_NAMES: Record<number, string> = { 11338: 'Instant Poison', 11357: 'Deadly Poison', 3599: 'Searing Totem', 5394: 'Healing Stream' };
