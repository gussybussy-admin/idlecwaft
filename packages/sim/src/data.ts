// Static game data, built locally by the importer from the client DBCs + the VMaNGOS world DB.
// The built JSON is Blizzard-derived and lives only in the local cache, never in git.

import type { ClassSpellOffer, SpellDef } from './spells.js';
import type { TalentDef, TalentTabDef } from './talents.js';
import type { FactionDef, QuestDef } from './quests.js';
import type { CreatureAbility, DungeonDef } from './dungeons.js';
import type { Profession } from './state.js';

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
  itemLevel?: number;
  /** What disenchanting it yields (greens and better). */
  disenchant?: LootRef;
  /** Resistances by school index (1 holy .. 6 arcane), and shield block value. */
  resist?: number[];
  block?: number;
  /** Reputation rank (index into REP_RANKS) needed with a faction to buy it. */
  reqRep?: [number, number];
  /** Elixirs and flasks: what they add for a dungeon or raid run (stats like ItemDef.stats, resistances by school). */
  elixir?: { stats: [number, number][]; hp: number; armor: number; ap: number; resist: number[]; durationMs: number };
  /** Protection potions: absorb this much damage of one school (1 holy .. 6 arcane). */
  protection?: { school: number; amount: number };
  /** Pet food type: 1 meat, 2 fish, 3 cheese, 4 bread, 5 fungus, 6 fruit. */
  foodType?: number;
  /** Bags: how many slots it adds, and (special bags, and the items they hold) the bag family bitmask. */
  bagSlots?: number;
  bagFamily?: number;
  /** Instant-use potion: health and mana restored (average). Used automatically in fights when low. */
  potion?: { heal: number; mana: number };
}

/** A permanent item enchantment (SpellItemEnchantment) flattened into the stats the idle fight uses. */
export interface EnchantDef {
  id: number; name: string;
  stats: [number, number][]; // [statType, value] like ItemDef.stats
  hp: number; mana: number; armor: number; ap: number; dmg: number;
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
  /** Skinning loot (beasts), and the Skinning skill it needs. */
  skin?: LootRef;
  /** Spells it casts in fights (the group simulation's boss mechanics). */
  abilities?: CreatureAbility[];
  /** Hunter pet family (CreatureFamily.dbc), when the beast can be tamed. */
  family?: number;
  /** Voice and combat sounds (SoundEntries ids): aggro, wound, death, attack. */
  sounds?: { aggro?: number; wound?: number; death?: number; attack?: number };
  /** Reputation for killing it: faction, amount, highest rank it can take you to; `side` limits it to one team. */
  rep?: { faction: number; value: number; maxRank: number; side?: Faction }[];
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
  skill: Profession;
  /** Item made (0 for enchantments). */
  item: ItemId;
  count: number;
  reagents: [ItemId, number][];
  /** Skill colour thresholds: orange from `orange`, yellow from `yellow`, green from `green`, grey from `grey`. */
  orange: number;
  yellow: number;
  green: number;
  grey: number;
  castMs: number;
  /** Required tools (blacksmith hammer, enchanting rod, ...), any of each listed id. */
  tools?: ItemId[];
  /** Enchanting: the enchantment and what it goes on (ItemDef.class, inventory type bit mask; 0 = any). */
  enchant?: { id: number; itemClass: number; invMask: number };
  /** Where the recipe comes from: trained by default, or taught by a recipe item. */
  source: { trainer: Copper } | { recipeItem: ItemId };
  /** The crafting sound (SoundEntries id). */
  sound?: number;
  /** A specialization's recipe (the specialization's spell id, see SPECS). */
  spec?: number;
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
  /** Zone music and ambience (SoundEntries ids, day and night). */
  sound?: { music?: [number, number]; ambience?: [number, number] };
}

export interface TaxiNode { id: number; name: string; map: number; x: number; y: number; zone: number; factions: Faction[] }
export interface TaxiPath { from: number; to: number; cost: Copper; length: number }

/** Sounds that aren't attached to a zone, creature or spell (SoundEntries ids). */
export interface GameSounds {
  /** Interface sounds by name: levelUp, questAdded, questComplete, questFailed, coins, bag, tab, spellbook, menuOpen, menuClose, eat, select. */
  ui: Record<string, number>;
  /** Gathering and crafting: mining, herbalism, skinning, fishing (+ fishHooked, fishReel), alchemy, tailoring, smelting, cooking. */
  activities: Record<string, number>;
  /** Melee impact by weapon subclass (-1: unarmed): a normal and a critical hit. */
  weapons: Record<number, { hit: number; crit: number }>;
}

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
  /** Weapon and armor skills each class may learn, with the level they unlock at (SkillRaceClassInfo.dbc). */
  classSkills: Record<number, Record<number, number>>;
  /** SkillLine names for weapon skills and Defense. */
  skillNames: Record<number, string>;
  /** Every class spell rank the game uses. */
  spells: Record<number, SpellDef>;
  sounds?: GameSounds;
  /** Hunter pet families: name and diet (bit n-1 set: eats food type n). */
  petFamilies?: Record<number, { name: string; diet: number }>;
  /** What each class learns: from its trainers (level, cost), plus starting spells at level 1 for free. */
  classSpells: Record<number, ClassSpellOffer[]>;
  /** Zones with a trainer for each class. */
  classTrainerZones: Record<number, number[]>;
  talents: Record<number, TalentDef>;
  talentTabs: Record<number, TalentTabDef>;
  /** Where each race starts. */
  startZones: Record<number, number>;
  /** [race][class][level] = [str, agi, sta, int, spi] */
  levelStats: Record<number, Record<number, [number, number, number, number, number][]>>;
  /** [class][level] = [baseHp, baseMana] */
  classStats: Record<number, [number, number][]>;
  skillRanks: Record<Profession, SkillRank[]>;
  enchants: Record<number, EnchantDef>;
  quests: Record<number, QuestDef>;
  dungeons: Record<number, DungeonDef>;
  factions: Record<number, FactionDef>;
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
