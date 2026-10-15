// Approximate per-item drop chances for display (exact rolling lives in @idle/sim).
// Quest-only drops are left out of previews until quests exist on the page.
import type { GameData, LootEntry, LootRef, LootTable } from '@idle/sim';

export function lootPreview(data: GameData, table: LootRef | LootTable | null, scale = 1, out = new Map<number, number>(), depth = 0): Map<number, number> {
  const t = typeof table === 'string' ? data.loot[table] : table;
  if (!t || depth > 8) return out;
  const live = (e: LootEntry) => !('quest' in e && e.quest);
  for (const e of t.entries) if (live(e)) add(data, e, e.chance / 100 * scale, out, depth);
  for (const group of t.groups) {
    const g = group.filter(live);
    const explicit = g.filter(e => e.chance > 0), equal = g.filter(e => e.chance === 0);
    const rest = Math.max(0, 1 - explicit.reduce((a, e) => a + e.chance / 100, 0));
    for (const e of explicit) add(data, e, e.chance / 100 * scale, out, depth);
    for (const e of equal) add(data, e, rest / equal.length * scale, out, depth);
  }
  return out;
}

function add(data: GameData, e: LootEntry, p: number, out: Map<number, number>, depth: number) {
  if ('ref' in e) { for (let i = 0; i < e.times; i++) lootPreview(data, e.ref, p, out, depth + 1); }
  else out.set(e.item, (out.get(e.item) ?? 0) + p);
}

/** Top drops by chance, as [itemId, percent]. */
export function topDrops(data: GameData, table: LootRef | null, n: number): [number, number][] {
  return [...lootPreview(data, table)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([i, p]) => [i, p * 100]);
}
