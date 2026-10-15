// Static game data, built locally by the importer from the client DBCs + the VMaNGOS world DB.
// The built JSON is Blizzard-derived and lives only in the local cache, never in git.

export type ItemId = number;
export type Copper = number;
export type Faction = 'alliance' | 'horde';
export const FACTIONS: Faction[] = ['alliance', 'horde'];

/** Key into GameData.loot. Tables are shared (reference tables appear under hundreds of creatures). */
export type LootRef = string;

/** One loot table. Ungrouped entries roll independently; each group yields at most one entry. */
export interface LootTable {
  entries: LootEntry[];
  groups: LootEntry[][];
}
export type LootEntry =
  /** `quest`: only drops while the looter has a quest that needs it. */
  | { item: ItemId; chance: number; min: number; max: number; quest?: true }
  | { ref: LootRef; chance: number; times: number };

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
  loot: LootRef | null;
  /** Player factions that can attack it (a Stormwind guard is attackable by the Horde only). */
  hostile: Faction[];
}

export type GatherSkill = 'mining' | 'herbalism';

export interface NodeDef {
  id: number;        // gameobject entry
  name: string;
  skill: GatherSkill;
  reqSkill: number;
  displayId: number;
  loot: LootRef;
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
  map: number;          // 0 Eastern Kingdoms, 1 Kalimdor
  /** Centre of the zone's spawns, in world yards (used for travel distances). */
  x: number;
  y: number;
  city: boolean;
  levelMin: number;
  levelMax: number;
  creatures: { id: number; spawns: number }[];
  nodes: { id: number; spawns: number }[];
  fishing: { zoneSkill: number; loot: LootRef } | null;
  /** Vendor stock; `factions` lists the player factions the vendor will trade with. */
  vendorItems: { item: ItemId; vendor: string; factions: Faction[] }[];
  taxiNodes: number[];
}

export interface TaxiNode { id: number; name: string; map: number; x: number; y: number; zone: number; factions: Faction[] }
export interface TaxiPath { from: number; to: number; cost: Copper; length: number }

export interface GameData {
  version: 2;
  builtAt: string;
  build: number;
  /** xpToNext[level] = XP needed to go from `level` to `level + 1`. */
  xpToNext: number[];
  maxLevel: number;
  races: { id: number; name: string; faction: Faction }[];
  classes: { id: number; name: string }[];
  /** Playable classes per race (CharBaseInfo.dbc). */
  raceClasses: Record<number, number[]>;
  /** Where each race starts. */
  startZones: Record<number, number>;
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
  loot: Record<LootRef, LootTable>;
  taxiNodes: Record<number, TaxiNode>;
  taxiPaths: TaxiPath[];
}

export const factionOfRace = (data: GameData, race: number): Faction =>
  data.races.find(r => r.id === race)?.faction ?? 'alliance';
