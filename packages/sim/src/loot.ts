// Loot rolling with MaNGOS semantics: ungrouped entries roll independently; a group yields at most
// one entry, trying explicitly-chanced entries first and then picking evenly among 0-chance entries.
import type { LootEntry, LootTable } from './data.js';
import { chance, int, next, type RngState } from './rng.js';

export type Drops = Map<number, number>; // itemId -> count

export function rollLoot(table: LootTable | null, rng: RngState, out: Drops = new Map()): Drops {
  if (!table) return out;
  for (const e of table.entries) if (chance(rng, e.chance)) give(e, rng, out);
  for (const group of table.groups) {
    const explicit = group.filter(e => e.chance > 0), equal = group.filter(e => e.chance === 0);
    let roll = next(rng) * 100, picked: LootEntry | undefined;
    for (const e of explicit) { if (roll < e.chance) { picked = e; break; } roll -= e.chance; }
    if (!picked && equal.length) picked = equal[Math.floor(next(rng) * equal.length)];
    if (picked) give(picked, rng, out);
  }
  return out;
}

function give(e: LootEntry, rng: RngState, out: Drops): void {
  if ('ref' in e) {
    for (let i = 0; i < e.times; i++) rollLoot(e.ref, rng, out);
  } else {
    out.set(e.item, (out.get(e.item) ?? 0) + int(rng, e.min, e.max));
  }
}
