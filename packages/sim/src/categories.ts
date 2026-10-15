// Item categories for bags, vendors and the guild bank (from the item's class, quality and use).
import type { GameData, ItemDef } from './data.js';

export const ITEM_CATEGORIES = [
  'Weapons', 'Armor', 'Consumables', 'Trade Goods', 'Tools', 'Recipes', 'Quest Items', 'Containers', 'Ammo', 'Junk', 'Other',
] as const;
export type ItemCategory = typeof ITEM_CATEGORIES[number];

// Item classes (ItemClass.dbc).
const CONSUMABLE = 0, CONTAINER = 1, WEAPON = 2, ARMOR = 4, REAGENT = 5, PROJECTILE = 6, TRADE_GOODS = 7,
  RECIPE = 9, QUIVER = 11, QUEST = 12, MISC = 15;
const FISHING_POLE = 20;

const toolsCache = new WeakMap<GameData, { tools: Set<number>; reagents: Set<number> }>();
function uses(data: GameData) {
  let u = toolsCache.get(data);
  if (!u) {
    u = { tools: new Set(), reagents: new Set() };
    for (const r of Object.values(data.recipes)) {
      for (const t of r.tools ?? []) u.tools.add(t);
      for (const [i] of r.reagents) u.reagents.add(i);
    }
    toolsCache.set(data, u);
  }
  return u;
}

export function itemCategory(data: GameData, it: ItemDef): ItemCategory {
  const u = uses(data);
  if (it.tool || u.tools.has(it.id) || (it.class === WEAPON && it.subclass === FISHING_POLE)) return 'Tools';
  if (it.quality === 0) return 'Junk';
  if (it.food || it.potion) return 'Consumables';
  switch (it.class) {
    case WEAPON: return 'Weapons';
    case ARMOR: return 'Armor';
    case CONSUMABLE: return 'Consumables';
    case CONTAINER: case QUIVER: return 'Containers';
    case REAGENT: case TRADE_GOODS: return 'Trade Goods';
    case RECIPE: return 'Recipes';
    case QUEST: return 'Quest Items';
    case PROJECTILE: return 'Ammo';
    case MISC: return u.reagents.has(it.id) ? 'Trade Goods' : 'Other';
    default: return u.reagents.has(it.id) ? 'Trade Goods' : 'Other';
  }
}
