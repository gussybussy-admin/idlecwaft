// Builds cache/data/game.json for the given zones from the client DBCs + VMaNGOS world DB.
// Everything that decides *what exists* (skills, recipes' skill thresholds, zones, icons) comes from
// the client; what the client never had (stats, spawns, loot, vendors) comes from VMaNGOS.
import fs from 'node:fs';
import path from 'node:path';
import type {
  CreatureDef, GameData, ItemDef, NodeDef, RecipeDef, SkillRank, ZoneDef,
} from '@idle/sim';
import type { Client } from '../client.js';
import { ZoneLookup } from './zone-lookup.js';
import { PATCH_1_12, VMangos, type Row } from './vmangos.js';

const SKILL_COOKING = 185;
const LOCKTYPE_HERBALISM = 2, LOCKTYPE_MINING = 3, LOCK_KEY_SKILL = 2;
const GO_TYPE_CHEST = 3;
const NPC_FLAG_VENDOR = 0x4;
const CREATURE_TYPE_CRITTER = 8, CREATURE_TYPE_NOT_SPECIFIED = 10;
// Food / drink auras: MOD_REGEN / MOD_POWER_REGEN restore (basePoints + 1) every 5 seconds.
const AURA_MOD_REGEN = 84, AURA_MOD_POWER_REGEN = 85, REGEN_TICK_MS = 5000;
const SLA_LEARNED_WITH_SKILL = 1;
const ALLIANCE_FACTIONS = new Set([1, 3, 4, 8, 72, 47, 54, 69, 469, 115]);

// Profession rank spells (Apprentice, Journeyman, Expert, Artisan). Costs/levels come from trainer data.
const RANK_SPELLS: Record<keyof GameData['skillRanks'], number[]> = {
  mining: [2575, 2576, 3564, 10248],
  herbalism: [2366, 2368, 3570, 11993],
  fishing: [7620, 7731, 7732, 18248],
  cooking: [2550, 3102, 3413, 18260],
};
const RANK_NAMES = ['Apprentice', 'Journeyman', 'Expert', 'Artisan'];
const RANK_LEVELS = [5, 10, 20, 35];

export interface BuildOptions { zones: number[]; cacheDir: string; repoRoot: string; log?: (s: string) => void }

export function buildGameData(client: Client, opts: BuildOptions): GameData {
  const log = opts.log ?? (() => {});
  const vm = VMangos.open(opts.repoRoot);
  const zl = new ZoneLookup(client);
  const items = new Set<number>();
  const wanted = new Set(opts.zones);

  // ---- DBC lookups
  const areaTable = client.dbc('AreaTable');
  const areaName = new Map(areaTable.rows().map(r => [areaTable.u32(r, 0), areaTable.str(r, 11)]));
  const lock = client.dbc('Lock'); // 0 id, 1-8 type, 9-16 index, 17-24 skill
  const lockReq = new Map<number, { skill: 'mining' | 'herbalism'; req: number }>();
  for (const r of lock.rows()) for (let i = 0; i < 8; i++) {
    if (lock.u32(r, 1 + i) !== LOCK_KEY_SKILL) continue;
    const idx = lock.u32(r, 9 + i);
    if (idx === LOCKTYPE_MINING || idx === LOCKTYPE_HERBALISM) {
      lockReq.set(lock.u32(r, 0), { skill: idx === LOCKTYPE_MINING ? 'mining' : 'herbalism', req: lock.u32(r, 17 + i) });
    }
  }
  const ft = client.dbc('FactionTemplate'); // 0 id, 1 faction, 3 ourMask, 4 friendlyMask, 5 hostileMask, 10-13 friends
  const attackableFT = new Set<number>();
  for (const r of ft.rows()) {
    const our = ft.u32(r, 3), friendly = ft.u32(r, 4);
    const friends = [10, 11, 12, 13].map(f => ft.u32(r, f));
    const friendlyToAlliance = (friendly & 0x3) || (our & 0x2) || friends.some(f => ALLIANCE_FACTIONS.has(f)) || ALLIANCE_FACTIONS.has(ft.u32(r, 1));
    if (!friendlyToAlliance) attackableFT.add(ft.u32(r, 0));
  }
  const durations = new Map(client.dbc('SpellDuration').rows().map(r => [client.dbc('SpellDuration').u32(r, 0), client.dbc('SpellDuration').i32(r, 1)]));
  const castTimes = new Map(client.dbc('SpellCastTimes').rows().map(r => [client.dbc('SpellCastTimes').u32(r, 0), client.dbc('SpellCastTimes').i32(r, 1)]));
  const idi = client.dbc('ItemDisplayInfo');
  const icons = new Map(idi.rows().map(r => [idi.u32(r, 0), idi.str(r, 5)]));

  // ---- spawns -> zones
  const creatureSpawns = new Map<number, Map<number, number>>(); // zone -> entry -> count
  const vendorsByZone = new Map<number, Set<number>>();
  const eventCreatures = vm.eventCreatureGuids(), eventObjects = vm.eventGameobjectGuids();
  const spawnRows = vm.all(`SELECT guid, id, map, position_x x, position_y y FROM creature WHERE map IN (0,1) AND patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12);
  for (const s of spawnRows) {
    if (eventCreatures.has(Number(s.guid))) continue;
    const zone = zl.zoneAt(Number(s.map), Number(s.x), Number(s.y));
    if (!wanted.has(zone)) continue;
    const m = creatureSpawns.get(zone) ?? new Map<number, number>();
    m.set(Number(s.id), (m.get(Number(s.id)) ?? 0) + 1);
    creatureSpawns.set(zone, m);
  }
  const goSpawns = new Map<number, Map<number, number>>();
  const goRows = vm.all(`SELECT guid, id, map, position_x x, position_y y FROM gameobject WHERE map IN (0,1) AND patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12);
  for (const s of goRows) {
    if (eventObjects.has(Number(s.guid))) continue;
    const zone = zl.zoneAt(Number(s.map), Number(s.x), Number(s.y));
    if (!wanted.has(zone)) continue;
    const m = goSpawns.get(zone) ?? new Map<number, number>();
    m.set(Number(s.id), (m.get(Number(s.id)) ?? 0) + 1);
    goSpawns.set(zone, m);
  }
  log(`spawns: ${spawnRows.length} creatures, ${goRows.length} gameobjects scanned`);

  // ---- creatures
  const classStats = new Map<string, Row>();
  for (const r of vm.all(`SELECT * FROM creature_classlevelstats`)) classStats.set(`${r.class}:${r.level}`, r);
  const creatures: Record<number, CreatureDef> = {};
  const zones: ZoneDef[] = [];
  for (const zoneId of opts.zones) {
    const zone: ZoneDef = { id: zoneId, name: areaName.get(zoneId) ?? `Zone ${zoneId}`, levelMin: 99, levelMax: 0,
      creatures: [], nodes: [], fishing: null, vendorItems: [] };
    for (const [entry, spawns] of creatureSpawns.get(zoneId) ?? []) {
      const t = vm.creatureTemplate(entry);
      if (!t) continue;
      const npcFlags = Number(t.npc_flags);
      if (npcFlags & NPC_FLAG_VENDOR) (vendorsByZone.get(zoneId) ?? vendorsByZone.set(zoneId, new Set()).get(zoneId)!).add(entry);
      const type = Number(t.type);
      if (npcFlags || type === CREATURE_TYPE_CRITTER || type === CREATURE_TYPE_NOT_SPECIFIED || !attackableFT.has(Number(t.faction))) continue;
      const def = creatureDef(t, classStats, vm, items);
      if (!def || (!def.loot && !def.goldMax)) continue; // nothing to farm (pets, scripted dummies)
      creatures[entry] = def;
      zone.creatures.push({ id: entry, spawns });
      zone.levelMin = Math.min(zone.levelMin, def.levelMin);
      zone.levelMax = Math.max(zone.levelMax, def.levelMax);
    }
    zone.creatures.sort((a, b) => creatures[a.id].levelMin - creatures[b.id].levelMin || b.spawns - a.spawns);
    zones.push(zone);
  }

  // ---- gathering nodes
  const nodes: Record<number, NodeDef> = {};
  for (const zone of zones) {
    for (const [entry, spawns] of goSpawns.get(zone.id) ?? []) {
      const t = vm.gameobjectTemplate(entry);
      if (!t || Number(t.type) !== GO_TYPE_CHEST) continue;
      const req = lockReq.get(Number(t.data0));
      if (!req) continue;
      const loot = vm.loot('gameobject_loot_template', Number(t.data1), items);
      if (!loot) continue;
      nodes[entry] = { id: entry, name: String(t.name), skill: req.skill, reqSkill: req.req, displayId: Number(t.displayId), loot };
      zone.nodes.push({ id: entry, spawns });
    }
    zone.nodes.sort((a, b) => nodes[a.id].reqSkill - nodes[b.id].reqSkill);

    // ---- fishing: zone-level loot, catch difficulty from skill_fishing_base_level
    const fishLoot = vm.loot('fishing_loot_template', zone.id, items);
    const base = vm.get(`SELECT skill FROM skill_fishing_base_level WHERE entry=?`, zone.id);
    if (fishLoot) zone.fishing = { zoneSkill: Number(base?.skill ?? 0), loot: fishLoot };

    // ---- vendors in the zone
    const seen = new Set<number>();
    for (const v of vendorsByZone.get(zone.id) ?? []) {
      const t = vm.creatureTemplate(v);
      const rows = [
        ...vm.all(`SELECT item FROM npc_vendor WHERE entry=?`, v),
        ...(Number(t?.vendor_id) ? vm.all(`SELECT item FROM npc_vendor_template WHERE entry=?`, Number(t!.vendor_id)) : []),
      ];
      for (const r of rows) {
        const id = Number(r.item);
        if (seen.has(id) || !vm.itemTemplate(id)) continue;
        seen.add(id); items.add(id);
        zone.vendorItems.push({ item: id, vendor: String(t?.name ?? '') });
      }
    }
  }

  // ---- cooking recipes: thresholds from SkillLineAbility.dbc, reagents/products from spell data
  const sla = client.dbc('SkillLineAbility'); // 1 skill, 2 spell, 7 minRank, 10 grey (trivial high), 11 yellow (trivial low)
  const obtainable = new Set(items);
  const recipes: Record<number, RecipeDef> = {};
  for (const r of sla.rows()) {
    if (sla.u32(r, 1) !== SKILL_COOKING || !sla.u32(r, 10)) continue;
    const spellId = sla.u32(r, 2);
    const s = vm.spell(spellId);
    if (!s || Number(s.effect1) !== 24 || !Number(s.effectItemType1)) continue; // SPELL_EFFECT_CREATE_ITEM
    const reagents: [number, number][] = [];
    for (let i = 1; i <= 8; i++) if (Number(s[`reagent${i}`])) reagents.push([Number(s[`reagent${i}`]), Number(s[`reagentCount${i}`])]);
    if (!reagents.every(([id]) => obtainable.has(id))) continue; // only what this zone set can supply
    const learnedWithSkill = sla.u32(r, 9) === SLA_LEARNED_WITH_SKILL;
    const trainer = learnedWithSkill ? { cost: 0, reqSkill: sla.u32(r, 7), reqLevel: 0 } : vm.trainerOffer(spellId);
    const recipeItem = vm.recipeItem(spellId);
    if (!trainer && !(recipeItem && obtainable.has(Number(recipeItem.entry)))) continue;
    const grey = sla.u32(r, 10), yellow = sla.u32(r, 11);
    const orange = (trainer ? trainer.reqSkill : Number(recipeItem?.required_skill_rank)) || 1;
    recipes[spellId] = {
      spellId, name: String(s.name), skill: 'cooking', item: Number(s.effectItemType1),
      count: Math.max(1, Number(s.effectBasePoints1) + 1), reagents,
      orange, yellow, green: Math.floor((yellow + grey) / 2), grey,
      castMs: castTimes.get(Number(s.castingTimeIndex)) ?? 3000,
      source: trainer ? { trainer: trainer.cost } : { recipeItem: Number(recipeItem!.entry) },
    };
    items.add(Number(s.effectItemType1));
    for (const [id] of reagents) items.add(id);
  }

  // ---- tools always available
  for (const id of [2901, 6256]) items.add(id); // Mining Pick, Fishing Pole

  // ---- items
  const itemDefs: Record<number, ItemDef> = {};
  for (const id of items) {
    const t = vm.itemTemplate(id);
    if (!t) continue;
    itemDefs[id] = itemDef(t, icons, vm, durations);
  }

  // ---- player tables
  const xpToNext: number[] = [0];
  for (const r of vm.all(`SELECT * FROM player_xp_for_level ORDER BY lvl`)) xpToNext[Number(r.lvl)] = Number(r.xp_for_next_level);
  const races = client.dbc('ChrRaces'), classes = client.dbc('ChrClasses');
  const raceList = races.rows().map(r => ({ id: races.u32(r, 0), name: races.str(r, 17) }));
  const levelStats: GameData['levelStats'] = {};
  for (const r of vm.all(`SELECT * FROM player_levelstats ORDER BY race, class, level`)) {
    const race = Number(r.race), cls = Number(r.class);
    ((levelStats[race] ??= {})[cls] ??= [])[Number(r.level)] = [Number(r.str), Number(r.agi), Number(r.sta), Number(r.inte), Number(r.spi)];
  }
  const classStatsOut: GameData['classStats'] = {};
  for (const r of vm.all(`SELECT * FROM player_classlevelstats ORDER BY class, level`)) {
    (classStatsOut[Number(r.class)] ??= [])[Number(r.level)] = [Number(r.basehp), Number(r.basemana)];
  }

  // ---- profession ranks from trainer data
  const skillRanks = {} as GameData['skillRanks'];
  for (const [skill, spells] of Object.entries(RANK_SPELLS) as [keyof GameData['skillRanks'], number[]][]) {
    skillRanks[skill] = spells.map((spellId, i): SkillRank => {
      const t = vm.trainerOffer(spellId);
      return { name: RANK_NAMES[i], max: 75 * (i + 1), reqLevel: t?.reqLevel || RANK_LEVELS[i], cost: t?.cost ?? 0, spellId };
    });
  }

  vm.close();
  const data: GameData = {
    version: 1, builtAt: new Date().toISOString(), build: 5875,
    xpToNext, maxLevel: 60,
    races: raceList.filter(r => [1, 2, 3, 4, 5, 6, 7, 8].includes(r.id))
      .map(r => ({ ...r, faction: [1, 3, 4, 7].includes(r.id) ? 'alliance' as const : 'horde' as const })),
    classes: classes.rows().map(r => ({ id: classes.u32(r, 0), name: classes.str(r, 5) })),
    levelStats, classStats: classStatsOut, skillRanks,
    zones, creatures, items: itemDefs, nodes, recipes,
  };
  const out = path.join(opts.cacheDir, 'data');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'game.json'), JSON.stringify(data));
  return data;
}

function creatureDef(t: Row, classStats: Map<string, Row>, vm: VMangos, items: Set<number>): CreatureDef | null {
  const levelMin = Number(t.level_min), levelMax = Number(t.level_max);
  const stats: CreatureDef['stats'] = [];
  const attackMs = Number(t.base_attack_time) || 2000;
  for (let lvl = levelMin; lvl <= levelMax; lvl++) {
    const cls = classStats.get(`${t.unit_class}:${lvl}`);
    if (!cls) return null;
    // Base melee damage is the average hit at a 2.0 s swing; slower attackers hit proportionally harder.
    const avg = Number(cls.melee_damage) * (attackMs / 2000) * Number(t.damage_multiplier);
    const variance = Number(t.damage_variance) || 0.15;
    stats.push({
      hp: Math.max(1, Math.round(Number(cls.health) * Number(t.health_multiplier))),
      dmgMin: Math.max(1, Math.round(avg * (1 - variance))),
      dmgMax: Math.max(1, Math.round(avg * (1 + variance))),
      armor: Math.round(Number(cls.armor) * Number(t.armor_multiplier)),
    });
  }
  const displayIds = [t.display_id1, t.display_id2, t.display_id3, t.display_id4].map(Number).filter(Boolean);
  return {
    id: Number(t.entry), name: String(t.name), subname: String(t.subname ?? ''),
    levelMin, levelMax, rank: Number(t.rank), type: Number(t.type), displayIds, attackMs, stats,
    goldMin: Number(t.gold_min), goldMax: Number(t.gold_max),
    loot: vm.loot('creature_loot_template', Number(t.loot_id), items),
  };
}

function itemDef(t: Row, icons: Map<number, string>, vm: VMangos, durations: Map<number, number>): ItemDef {
  const stats: [number, number][] = [];
  for (let i = 1; i <= 10; i++) if (Number(t[`stat_value${i}`])) stats.push([Number(t[`stat_type${i}`]), Number(t[`stat_value${i}`])]);
  const def: ItemDef = {
    id: Number(t.entry), name: String(t.name), quality: Number(t.quality),
    icon: icons.get(Number(t.display_id)) ?? 'INV_Misc_QuestionMark', displayId: Number(t.display_id),
    class: Number(t.class), subclass: Number(t.subclass), invType: Number(t.inventory_type),
    reqLevel: Number(t.required_level), sellPrice: Number(t.sell_price), buyPrice: Number(t.buy_price),
    stack: Number(t.stackable) || 1, armor: Number(t.armor),
    dmgMin: Number(t.dmg_min1), dmgMax: Number(t.dmg_max1), delayMs: Number(t.delay), stats,
  };
  // Food and drink: an on-use aura that restores health/mana per tick over the aura duration.
  const spellId = Number(t.spellid_1);
  if (spellId && Number(t.spelltrigger_1) === 0) {
    const s = vm.spell(spellId);
    if (s) {
      const durationMs = durations.get(Number(s.durationIndex)) ?? 0;
      let heal = 0, mana = 0;
      for (let e = 1; e <= 3; e++) {
        const aura = Number(s[`effectApplyAuraName${e}`]);
        const total = Math.round((Number(s[`effectBasePoints${e}`]) + 1) * durationMs / REGEN_TICK_MS);
        if (aura === AURA_MOD_REGEN) heal += total;
        if (aura === AURA_MOD_POWER_REGEN) mana += total;
      }
      if (heal || mana) def.food = { heal, mana, durationMs };
    }
  }
  if (def.id === 2901) def.tool = 'mining-pick';
  if (def.class === 2 && def.subclass === 20) def.tool = 'fishing-pole';
  return def;
}
