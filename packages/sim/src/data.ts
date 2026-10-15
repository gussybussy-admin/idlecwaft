// Static game data, built locally by the importer from the client DBCs + the VMaNGOS world DB.
// The built JSON is Blizzard-derived and lives only in the local cache, never in git.

export type ItemId = number;
export type Copper = number;

/** One loot table. Ungrouped entries roll independently; each group yields at most one entry. */
export interface LootTable {
  entries: LootEntry[];
  groups: LootEntry[][];
}
export type LootEntry =
  | { item: ItemId; chance: number; min: number; max: number }
  | { ref: LootTable; chance: number; times: number };

export interface ItemDef {
  id: ItemId;
  name: string;
  quality: number;   // 0 poor .. 5 legendary
  icon: string;      // icon file name without extension, e.g. "INV_Misc_Food_14"
  displayId: number;
  class: number;
  subclass: number;
  invType: number;   // equip slot type, 0 = not equippable
  reqLevel: number;
  sellPrice: Copper;
  buyPrice: Copper;
  stack: number;
  armor: number;
  dmgMin: number;
  dmgMax: number;
  delayMs: number;
  stats: [number, number][]; // [statType, value]: 3 agi, 4 str, 5 int, 6 spi, 7 sta
  /** Food/drink: total restored over the eating duration. */
  food?: { heal: number; mana: number; durationMs: number };
  /** Tool category this item satisfies, if any (e.g. "mining-pick", "fishing-pole"). */
  tool?: string;
}

export interface CreatureDef {
  id: number;
  name: string;
  subname: string;
  levelMin: number;
  levelMax: number;
  rank: number;      // 0 normal, 1 elite, 2 rare elite, 3 boss, 4 rare
  type: number;      // CreatureType: 1 beast, 7 humanoid, ...
  displayIds: number[];
  attackMs: number;
  /** Per level (index = level - levelMin). */
  stats: { hp: number; dmgMin: number; dmgMax: number; armor: number }[];
  goldMin: Copper;
  goldMax: Copper;
  loot: LootTable | null;
}

export type GatherSkill = 'mining' | 'herbalism';

export interface NodeDef {
  id: number;        // gameobject entry
  name: string;
  skill: GatherSkill;
  reqSkill: number;
  displayId: number;
  loot: LootTable;
}

export interface RecipeDef {
  spellId: number;
  name: string;
  skill: 'cooking';
  item: ItemId;
  count: number;
  reagents: [ItemId, number][];
  /** Skill colour thresholds: orange from `orange`, yellow from `yellow`, green from `green`, grey from `grey`. */
  orange: number;
  yellow: number;
  green: number;
  grey: number;
  castMs: number;
  /** Where the recipe comes from: trained by default, or taught by a recipe item. */
  source: { trainer: Copper } | { recipeItem: ItemId };
}

export interface SkillRank { name: string; max: number; reqLevel: number; cost: Copper; spellId: number }

export interface ZoneDef {
  id: number;
  name: string;
  levelMin: number;
  levelMax: number;
  creatures: { id: number; spawns: number }[];
  nodes: { id: number; spawns: number }[];
  fishing: { zoneSkill: number; loot: LootTable } | null;
  vendorItems: { item: ItemId; vendor: string }[];
}

export interface GameData {
  version: 1;
  builtAt: string;
  build: number;
  /** xpToNext[level] = XP needed to go from `level` to `level + 1`. */
  xpToNext: number[];
  maxLevel: number;
  races: { id: number; name: string; faction: 'alliance' | 'horde' }[];
  classes: { id: number; name: string }[];
  /** [race][class][level] = [str, agi, sta, int, spi] */
  levelStats: Record<number, Record<number, [number, number, number, number, number][]>>;
  /** [class][level] = [baseHp, baseMana] */
  classStats: Record<number, [number, number][]>;
  skillRanks: Record<'mining' | 'herbalism' | 'fishing' | 'cooking', SkillRank[]>;
  zones: ZoneDef[];
  creatures: Record<number, CreatureDef>;
  items: Record<number, ItemDef>;
  nodes: Record<number, NodeDef>;
  recipes: Record<number, RecipeDef>;
}
