// Approximate per-item drop chances for display (exact rolling lives in @idle/sim).
import type { LootTable } from '@idle/sim';

export function lootPreview(table: LootTable | null, scale = 1, out = new Map<number, number>()): Map<number, number> {
  if (!table) return out;
  for (const e of table.entries) add(e, e.chance / 100 * scale, out);
  for (const g of table.groups) {
    const explicit = g.filter(e => e.chance > 0), equal = g.filter(e => e.chance === 0);
    const rest = Math.max(0, 1 - explicit.reduce((a, e) => a + e.chance / 100, 0));
    for (const e of explicit) add(e, e.chance / 100 * scale, out);
    for (const e of equal) add(e, rest / equal.length * scale, out);
  }
  return out;
}

function add(e: LootTable['entries'][number], p: number, out: Map<number, number>) {
  if ('ref' in e) { for (let i = 0; i < e.times; i++) lootPreview(e.ref, p, out); }
  else out.set(e.item, (out.get(e.item) ?? 0) + p);
}

/** Top drops by chance, as [itemId, percent]. */
export function topDrops(table: LootTable | null, n: number): [number, number][] {
  return [...lootPreview(table)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([i, p]) => [i, p * 100]);
}
