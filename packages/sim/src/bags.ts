// Bags: a 16-slot backpack plus four bag slots. Every stack takes a slot (a stack is as many as the item
// stacks to); special bags (quivers, ammo pouches, soul bags, herb bags, ...) only hold items of their
// family. Loot, gathering, fishing, crafting and vendor purchases need room; rewards from quests and
// dungeon runs always arrive (bags can then be over full, and nothing new fits until there's room).
import type { GameData, ItemDef } from './data.js';
import type { GameState } from './state.js';

export const BACKPACK_SLOTS = 16;
export const BAG_SLOTS = 4;

export interface BagSpace {
  /** Slots in the backpack and general bags, and how many are used. */
  total: number; used: number;
  /** Special bags: family bitmask, slots, used. */
  special: { family: number; slots: number; used: number }[];
}

const stacks = (it: ItemDef | undefined, n: number) => (n > 0 ? Math.ceil(n / Math.max(1, it?.stack ?? 1)) : 0);

/** How full your bags are. Items of a family go into matching special bags first. */
export function bagSpace(s: GameState, data: GameData): BagSpace {
  let total = BACKPACK_SLOTS;
  const special: BagSpace['special'] = [];
  for (const id of s.bags ?? []) {
    const b = id ? data.items[id] : undefined;
    if (!b?.bagSlots) continue;
    if (b.bagFamily) special.push({ family: b.bagFamily, slots: b.bagSlots, used: 0 });
    else total += b.bagSlots;
  }
  let used = 0;
  for (const [id, n] of Object.entries(s.inventory)) {
    const it = data.items[+id];
    let need = stacks(it, n);
    for (const sb of special) {
      if (!need || !it?.bagFamily || !(it.bagFamily & sb.family)) continue;
      const take = Math.min(need, sb.slots - sb.used);
      sb.used += take;
      need -= take;
    }
    used += need;
  }
  return { total, used, special };
}

/** How many of `item` fit in your bags right now (topping up stacks first). */
export function roomFor(s: GameState, data: GameData, item: number, space = bagSpace(s, data)): number {
  const it = data.items[item];
  const stack = Math.max(1, it?.stack ?? 1);
  const have = s.inventory[item] ?? 0;
  const topUp = have % stack ? stack - (have % stack) : 0;
  let slots = Math.max(0, space.total - space.used);
  if (it?.bagFamily) for (const sb of space.special) if (it.bagFamily & sb.family) slots += Math.max(0, sb.slots - sb.used);
  return topUp + slots * stack;
}

/**
 * Puts up to `n` of `item` in your bags; returns how many fit (the rest is lost: left on the corpse,
 * the node or the floor).
 */
export function giveItem(s: GameState, data: GameData, item: number, n: number): number {
  const fit = Math.min(n, roomFor(s, data, item));
  if (fit > 0) s.inventory[item] = (s.inventory[item] ?? 0) + fit;
  return fit;
}

/** Gives a list of drops; returns what fitted (and what didn't). */
export function giveItems(s: GameState, data: GameData, drops: Iterable<[number, number]>): { got: [number, number][]; lost: [number, number][] } {
  const got: [number, number][] = [], lost: [number, number][] = [];
  for (const [i, n] of drops) {
    const g = giveItem(s, data, i, n);
    if (g > 0) got.push([i, g]);
    if (g < n) lost.push([i, n - g]);
  }
  return { got, lost };
}

/**
 * Puts a bag in a bag slot (the first empty one, or in place of your smallest bag, which goes back
 * into your bags if there's room).
 */
export function equipBag(s: GameState, data: GameData, item: number): { ok: true } | { ok: false; error: string } {
  const it = data.items[item];
  if (!it?.bagSlots) return { ok: false, error: "That isn't a bag." };
  if (!(s.inventory[item] ?? 0)) return { ok: false, error: "You don't have that." };
  const bags = s.bags ?? [];
  while (bags.length < BAG_SLOTS) bags.push(null);
  let slot = bags.findIndex(b => !b);
  if (slot < 0) {
    slot = bags.reduce<number>((m, b, i) => ((data.items[b ?? 0]?.bagSlots ?? 0) < (data.items[bags[m] ?? 0]?.bagSlots ?? 0) ? i : m), 0);
    if ((data.items[bags[slot]!]?.bagSlots ?? 0) >= it.bagSlots) return { ok: false, error: 'Your bags are already at least that big.' };
  }
  const old = bags[slot];
  const before = { inv: { ...s.inventory }, bags: [...bags] };
  s.inventory[item]--;
  if (!s.inventory[item]) delete s.inventory[item];
  bags[slot] = item;
  s.bags = bags;
  if (old) s.inventory[old] = (s.inventory[old] ?? 0) + 1;
  const sp = bagSpace(s, data);
  if (sp.used > sp.total) { s.inventory = before.inv; s.bags = before.bags; return { ok: false, error: 'Make room first: your things would no longer fit.' }; }
  return { ok: true };
}

/** Takes a bag off (into your bags), if everything still fits without it. */
export function unequipBag(s: GameState, data: GameData, slot: number): { ok: true } | { ok: false; error: string } {
  const id = s.bags?.[slot];
  if (!id) return { ok: false, error: 'No bag there.' };
  s.bags![slot] = null;
  s.inventory[id] = (s.inventory[id] ?? 0) + 1;
  const sp = bagSpace(s, data);
  if (sp.used > sp.total) {
    s.inventory[id]--;
    if (!s.inventory[id]) delete s.inventory[id];
    s.bags![slot] = id;
    return { ok: false, error: "Your things wouldn't fit without that bag." };
  }
  return { ok: true };
}

/** A starter bag for a character of this level (characters from before bag limits get four). */
export function starterBag(data: GameData, level: number): number | null {
  const want = level >= 40 ? 14 : level >= 20 ? 10 : 6;
  const general = Object.values(data.items).filter(i => i.bagSlots && !i.bagFamily && i.bagSlots <= want)
    .sort((a, b) => b.bagSlots! - a.bagSlots! || a.buyPrice - b.buyPrice);
  return general[0]?.id ?? null;
}
