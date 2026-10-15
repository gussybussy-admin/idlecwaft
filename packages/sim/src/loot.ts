// Loot rolling with MaNGOS semantics: ungrouped entries roll independently; a group yields at most
// one entry, trying explicitly-chanced entries first and then picking evenly among 0-chance entries.
// Quest-only entries take part only while the looter needs the item for an active quest.
import type { GameData, LootEntry, LootRef, LootTable } from './data.js';
import { chance, int, next, type RngState } from './rng.js';

export type Drops = Map<number, number>; // itemId -> count

export function rollLoot(data: GameData, table: LootRef | LootTable | null, rng: RngState,
  questItems: ReadonlySet<number> = NO_QUEST_ITEMS, out: Drops = new Map(), depth = 0): Drops {
  const t = typeof table === 'string' ? data.loot[table] : table;
  if (!t || depth > 8) return out;
  const live = (e: LootEntry) => !('quest' in e && e.quest) || questItems.has((e as { item: number }).item);
  for (const e of t.entries) if (live(e) && chance(rng, e.chance)) give(data, e, rng, questItems, out, depth);
  for (const group of t.groups) {
    const g = group.filter(live);
    const explicit = g.filter(e => e.chance > 0), equal = g.filter(e => e.chance === 0);
    let roll = next(rng) * 100, picked: LootEntry | undefined;
    for (const e of explicit) { if (roll < e.chance) { picked = e; break; } roll -= e.chance; }
    if (!picked && equal.length) picked = equal[Math.floor(next(rng) * equal.length)];
    if (picked) give(data, picked, rng, questItems, out, depth);
  }
  return out;
}

const NO_QUEST_ITEMS: ReadonlySet<number> = new Set();

function give(data: GameData, e: LootEntry, rng: RngState, q: ReadonlySet<number>, out: Drops, depth: number): void {
  if ('ref' in e) {
    for (let i = 0; i < e.times; i++) rollLoot(data, e.ref, rng, q, out, depth + 1);
  } else {
    out.set(e.item, (out.get(e.item) ?? 0) + int(rng, e.min, e.max));
  }
}
