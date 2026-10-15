// Builds cache/data/game.json from the client DBCs + VMaNGOS world DB, for every zone of both
// continents (or a chosen subset). Everything that decides *what exists* (skills, recipe skill
// thresholds, zones, flight paths, icons) comes from the client; what the client never had (stats,
// spawns, loot, vendors, trainers) comes from VMaNGOS, pinned to patch 1.12.
import fs from 'node:fs';
import path from 'node:path';
import type {
  CreatureDef, Faction, GameData, ItemDef, LootRef, NodeDef, TaxiNode, TaxiPath, ZoneDef,
} from '@idle/sim';
import type { Client } from '../client.js';
import { ZoneLookup } from './zone-lookup.js';
import { PATCH_1_12, VMangos, type Row } from './vmangos.js';
import { buildClassSpells } from './class-spells.js';
import { buildTalents } from './talents.js';
import { buildEnchants, buildRecipes, buildSkillRanks } from './professions.js';
import { buildFactions, buildQuests, killReputation } from './quests.js';

const LOCKTYPE_HERBALISM = 2, LOCKTYPE_MINING = 3, LOCK_KEY_SKILL = 2;
const GO_TYPE_CHEST = 3;
const NPC_FLAG_VENDOR = 0x4;
const CREATURE_TYPE_CRITTER = 8, CREATURE_TYPE_NOT_SPECIFIED = 10;
// Food / drink auras: MOD_REGEN / MOD_POWER_REGEN restore (basePoints + 1) every 5 seconds.
const AURA_MOD_REGEN = 84, AURA_MOD_POWER_REGEN = 85, REGEN_TICK_MS = 5000;
const AURA_PERIODIC_HEAL = 8, EFFECT_HEAL = 10, EFFECT_ENERGIZE = 30;
// Profession tools: skinning knife, blacksmith hammer, arclight spanner, and the runed enchanting rods.
const TOOLS = [2901, 6256, 7005, 5956, 6219, 6218, 6339, 11130, 11145, 16207];

// Faction.dbc ids of the playable factions and their capitals, per side.
const PLAYER_FACTIONS: Record<Faction, Set<number>> = {
  alliance: new Set([1, 3, 4, 8, 72, 47, 54, 69, 469, 115, 589, 730, 890]),
  horde: new Set([2, 5, 6, 116, 67, 76, 68, 81, 530, 510, 729, 889]),
};
const GROUP_BIT: Record<Faction, number> = { alliance: 0x2, horde: 0x4 }; // FactionGroup masks; 0x1 = all players

const START_ZONES: Record<number, number> = { 1: 12, 2: 14, 3: 1, 4: 141, 5: 85, 6: 215, 7: 1, 8: 14 };
const CITIES = new Set([1519, 1537, 1657, 1637, 1638, 1497]);
const EXCLUDED_ZONES = new Set([876, 616]); // GM Island, Hyjal (unfinished in vanilla)

/** `zones` empty = every zone on both continents. */
export interface BuildOptions { zones: number[]; cacheDir: string; repoRoot: string; log?: (s: string) => void }

interface ZoneAcc { creatures: Map<number, number>; objects: Map<number, number>; sx: number; sy: number; n: number; map: number }

export function buildGameData(client: Client, opts: BuildOptions): GameData {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const vm = VMangos.open(opts.repoRoot);
  const zl = new ZoneLookup(client);
  const items = new Set<number>();
  const wanted = opts.zones.length ? new Set(opts.zones) : null;

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
  // FactionTemplate: 0 id, 1 faction, 3 ourMask, 4 friendlyMask, 5 hostileMask, 6-9 enemies, 10-13 friends
  const ft = client.dbc('FactionTemplate');
  const relation = new Map<number, Record<Faction, 'friendly' | 'neutral' | 'hostile'>>();
  for (const r of ft.rows()) {
    const our = ft.u32(r, 3), friendly = ft.u32(r, 4), hostile = ft.u32(r, 5), faction = ft.u32(r, 1);
    const enemies = [6, 7, 8, 9].map(f => ft.u32(r, f)), friends = [10, 11, 12, 13].map(f => ft.u32(r, f));
    const rel = {} as Record<Faction, 'friendly' | 'neutral' | 'hostile'>;
    for (const side of ['alliance', 'horde'] as Faction[]) {
      const bit = GROUP_BIT[side], ids = PLAYER_FACTIONS[side];
      if ((friendly & bit) || (our & bit) || friends.some(f => ids.has(f)) || ids.has(faction)) rel[side] = 'friendly';
      else if ((hostile & (bit | 0x1)) || enemies.some(f => ids.has(f))) rel[side] = 'hostile';
      else rel[side] = 'neutral';
    }
    relation.set(ft.u32(r, 0), rel);
  }
  const attackers = (ftId: number): Faction[] => (['alliance', 'horde'] as Faction[]).filter(f => (relation.get(ftId)?.[f] ?? 'hostile') !== 'friendly');
  const traders = (ftId: number): Faction[] => (['alliance', 'horde'] as Faction[]).filter(f => (relation.get(ftId)?.[f] ?? 'neutral') !== 'hostile');

  const durations = new Map(client.dbc('SpellDuration').rows().map(r => [client.dbc('SpellDuration').u32(r, 0), client.dbc('SpellDuration').i32(r, 1)]));
  const castTimes = new Map(client.dbc('SpellCastTimes').rows().map(r => [client.dbc('SpellCastTimes').u32(r, 0), client.dbc('SpellCastTimes').i32(r, 1)]));
  const idi = client.dbc('ItemDisplayInfo');
  const icons = new Map(idi.rows().map(r => [idi.u32(r, 0), idi.str(r, 5)]));

  // ---- spawns -> zones (the client's own terrain says which zone each spawn stands in)
  const acc = new Map<number, ZoneAcc>();
  const zoneAcc = (zone: number, map: number) => acc.get(zone) ?? acc.set(zone, { creatures: new Map(), objects: new Map(), sx: 0, sy: 0, n: 0, map }).get(zone)!;
  const eventCreatures = vm.eventCreatureGuids(), eventObjects = vm.eventGameobjectGuids();
  const spawnRows = vm.all(`SELECT guid, id, map, position_x x, position_y y FROM creature WHERE map IN (0,1) AND patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12);
  for (const s of spawnRows) {
    if (eventCreatures.has(Number(s.guid))) continue;
    const zone = zl.zoneAt(Number(s.map), Number(s.x), Number(s.y));
    if (!zone || EXCLUDED_ZONES.has(zone) || (wanted && !wanted.has(zone))) continue;
    const a = zoneAcc(zone, Number(s.map));
    a.creatures.set(Number(s.id), (a.creatures.get(Number(s.id)) ?? 0) + 1);
    a.sx += Number(s.x); a.sy += Number(s.y); a.n++;
  }
  const goRows = vm.all(`SELECT guid, id, map, position_x x, position_y y FROM gameobject WHERE map IN (0,1) AND patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12);
  for (const s of goRows) {
    if (eventObjects.has(Number(s.guid))) continue;
    const zone = zl.zoneAt(Number(s.map), Number(s.x), Number(s.y));
    if (!zone || EXCLUDED_ZONES.has(zone) || (wanted && !wanted.has(zone))) continue;
    const a = zoneAcc(zone, Number(s.map));
    a.objects.set(Number(s.id), (a.objects.get(Number(s.id)) ?? 0) + 1);
  }
  log(`spawns: ${spawnRows.length} creatures, ${goRows.length} gameobjects in ${acc.size} zones`);

  // Zone level ranges the client itself advertises (LFGDungeons type 4 = zone).
  const lfg = client.dbc('LFGDungeons'); // 1 name, 10 min, 11 max, 12 type
  const lfgRange = new Map<string, [number, number]>();
  for (const r of lfg.rows()) if (lfg.u32(r, 12) === 4) lfgRange.set(lfg.str(r, 1).toLowerCase(), [lfg.u32(r, 10), lfg.u32(r, 11)]);

  // ---- creatures, nodes, fishing, vendors per zone
  const classStats = new Map<string, Row>();
  for (const r of vm.all(`SELECT * FROM creature_classlevelstats`)) classStats.set(`${r.class}:${r.level}`, r);
  const creatures: Record<number, CreatureDef> = {};
  const nodes: Record<number, NodeDef> = {};
  const zones: ZoneDef[] = [];
  const templateCache = new Map<number, Row | undefined>();
  const onKillRep = killReputation(vm);
  const template = (e: number) => { if (!templateCache.has(e)) templateCache.set(e, vm.creatureTemplate(e)); return templateCache.get(e); };

  for (const [zoneId, a] of acc) {
    const name = areaName.get(zoneId) ?? `Zone ${zoneId}`;
    const zone: ZoneDef = {
      id: zoneId, name, map: a.map, x: a.n ? Math.round(a.sx / a.n) : 0, y: a.n ? Math.round(a.sy / a.n) : 0,
      city: CITIES.has(zoneId), levelMin: 0, levelMax: 0, creatures: [], nodes: [], fishing: null, vendorItems: [], taxiNodes: [],
    };
    const levels: number[] = [];
    const vendorSeen = new Set<number>();
    for (const [entry, spawns] of a.creatures) {
      const t = template(entry);
      if (!t) continue;
      const npcFlags = Number(t.npc_flags);
      if (npcFlags & NPC_FLAG_VENDOR) addVendor(zone, t, vm, items, vendorSeen, traders(Number(t.faction)));
      const type = Number(t.type);
      if (npcFlags || type === CREATURE_TYPE_CRITTER || type === CREATURE_TYPE_NOT_SPECIFIED) continue;
      const hostile = attackers(Number(t.faction));
      if (!hostile.length) continue;
      const def = creatures[entry] ?? creatureDef(t, classStats, vm, items, hostile);
      if (!def || (!def.loot && !def.goldMax)) continue; // nothing to farm (pets, scripted dummies)
      if (onKillRep.has(entry)) def.rep = onKillRep.get(entry);
      creatures[entry] = def;
      zone.creatures.push({ id: entry, spawns });
      if (def.rank === 0 && hostile.length === 2) for (let i = 0; i < spawns; i++) levels.push((def.levelMin + def.levelMax) / 2);
    }
    zone.creatures.sort((x, y) => creatures[x.id].levelMin - creatures[y.id].levelMin || y.spawns - x.spawns);

    for (const [entry, spawns] of a.objects) {
      const t = vm.gameobjectTemplate(entry);
      if (!t || Number(t.type) !== GO_TYPE_CHEST) continue;
      const req = lockReq.get(Number(t.data0));
      if (!req) continue;
      const loot = vm.loot('gameobject_loot_template', Number(t.data1), items);
      if (!loot) continue;
      nodes[entry] = { id: entry, name: String(t.name), skill: req.skill, reqSkill: req.req, displayId: Number(t.displayId), loot };
      zone.nodes.push({ id: entry, spawns });
    }
    zone.nodes.sort((x, y) => nodes[x.id].reqSkill - nodes[y.id].reqSkill);

    const fishLoot = vm.loot('fishing_loot_template', zoneId, items);
    if (fishLoot) {
      const base = vm.get(`SELECT skill FROM skill_fishing_base_level WHERE entry=?`, zoneId);
      zone.fishing = { zoneSkill: Number(base?.skill ?? 0), loot: fishLoot };
    }

    // Level range: the client's own figure where it has one, else the middle 80% of wild spawns.
    const adv = lfgRange.get(name.toLowerCase()) ?? lfgRange.get(name.replace(/ Forest$/, '').toLowerCase());
    levels.sort((x, y) => x - y);
    const pct = (p: number) => levels.length ? Math.round(levels[Math.min(levels.length - 1, Math.floor(levels.length * p))]) : 0;
    // (The client has a few typos, e.g. Felwood "46-6"; fall back to the spawns when a range makes no sense.)
    [zone.levelMin, zone.levelMax] = adv && adv[1] >= adv[0] ? [adv[0], Math.min(60, adv[1])] : [pct(0.1), pct(0.9)];

    const playable = zone.creatures.length >= 3 || zone.nodes.length > 0 || zone.city;
    if (playable) zones.push(zone);
  }
  zones.sort((x, y) => x.map - y.map || x.levelMin - y.levelMin || x.name.localeCompare(y.name));
  log(`zones: ${zones.length}, creatures: ${Object.keys(creatures).length}, nodes: ${Object.keys(nodes).length}`);

  // ---- flight paths
  const tn = client.dbc('TaxiNodes'); // 0 id, 1 map, 2 x, 3 y, 5 name, 14 horde mount, 15 alliance mount
  const taxiNodes: Record<number, TaxiNode> = {};
  for (const r of tn.rows()) {
    const factions: Faction[] = [];
    if (tn.u32(r, 15)) factions.push('alliance');
    if (tn.u32(r, 14)) factions.push('horde');
    const map = tn.u32(r, 1);
    if (!factions.length || map > 1) continue; // boats/zeppelins and other maps
    const x = tn.f32(r, 2), y = tn.f32(r, 3);
    const zone = zl.zoneAt(map, x, y);
    const id = tn.u32(r, 0);
    taxiNodes[id] = { id, name: tn.str(r, 5), map, x: Math.round(x), y: Math.round(y), zone, factions };
    zones.find(z => z.id === zone)?.taxiNodes.push(id);
  }
  const tpn = client.dbc('TaxiPathNode'); // 1 path, 2 index, 3 map, 4 x, 5 y
  const pathPts = new Map<number, [number, number, number][]>();
  for (const r of tpn.rows()) (pathPts.get(tpn.u32(r, 1)) ?? pathPts.set(tpn.u32(r, 1), []).get(tpn.u32(r, 1))!).push([tpn.u32(r, 2), tpn.f32(r, 4), tpn.f32(r, 5)]);
  const tp = client.dbc('TaxiPath'); // 0 id, 1 from, 2 to, 3 cost
  const taxiPaths: TaxiPath[] = [];
  for (const r of tp.rows()) {
    const from = tp.u32(r, 1), to = tp.u32(r, 2);
    if (!taxiNodes[from] || !taxiNodes[to]) continue;
    const pts = (pathPts.get(tp.u32(r, 0)) ?? []).sort((p, q) => p[0] - q[0]);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    if (!length) length = Math.hypot(taxiNodes[from].x - taxiNodes[to].x, taxiNodes[from].y - taxiNodes[to].y);
    taxiPaths.push({ from, to, cost: tp.u32(r, 3), length: Math.round(length) });
  }
  // Nodes no route touches are leftovers the game never used (e.g. "Northshire Abbey").
  const routed = new Set(taxiPaths.flatMap(p => [p.from, p.to]));
  for (const id of Object.keys(taxiNodes).map(Number)) {
    if (routed.has(id)) continue;
    delete taxiNodes[id];
    for (const z of zones) z.taxiNodes = z.taxiNodes.filter(n => n !== id);
  }
  log(`flight paths: ${Object.keys(taxiNodes).length} nodes, ${taxiPaths.length} routes`);

  // ---- disenchanting results of everything seen so far (the dusts and essences enchanters work with)
  for (const id of [...items]) {
    const t = vm.cachedItem(id);
    if (t && Number(t.disenchant_id) && Number(t.quality) >= 2) vm.loot('disenchant_loot_template', Number(t.disenchant_id), items);
  }
  // ---- recipes for every profession, then the enchantments they apply
  for (const id of TOOLS) items.add(id);
  const recipes = buildRecipes(client, vm, castTimes, items);
  const enchants = buildEnchants(client, vm, new Set(Object.values(recipes).flatMap(r => (r.enchant ? [r.enchant.id] : []))));
  log(`recipes: ${Object.keys(recipes).length}, enchantments: ${Object.keys(enchants).length}`);

  // ---- quests: givers and enders placed by where they stand
  const homeOf = (pick: (a: ZoneAcc) => Map<number, number>) => {
    const best = new Map<number, [number, number]>();
    for (const [zone, a] of acc) for (const [entry, n] of pick(a)) if ((best.get(entry)?.[1] ?? 0) < n) best.set(entry, [zone, n]);
    return new Map([...best].map(([e, [z]]) => [e, z]));
  };
  const collectable = new Set<number>();
  const walk = (ref: LootRef | null | undefined, seen = new Set<string>()) => {
    const t = ref ? vm.tables[ref] : undefined;
    if (!t || seen.has(ref!)) return;
    seen.add(ref!);
    for (const e of [...t.entries, ...t.groups.flat()]) { if ('item' in e) collectable.add(e.item); else walk(e.ref, seen); }
  };
  for (const c of Object.values(creatures)) { walk(c.loot); walk(c.skin); }
  for (const nd of Object.values(nodes)) walk(nd.loot);
  for (const z of zones) { walk(z.fishing?.loot); for (const v of z.vendorItems) collectable.add(v.item); }
  for (const r of Object.values(recipes)) if (r.item) collectable.add(r.item);
  const quests = buildQuests(vm, {
    creatures, zones, npcZone: homeOf(a => a.creatures), goZone: homeOf(a => a.objects), collectable, traders, items,
  });
  log(`quests: ${Object.keys(quests).length} (${Object.values(quests).filter(q => q.task).length} with timed tasks)`);

  // ---- items
  const itemDefs: Record<number, ItemDef> = {};
  for (const id of items) {
    const t = vm.cachedItem(id);
    if (t) itemDefs[id] = itemDef(t, icons, vm, durations);
  }

  // ---- player tables
  const xpToNext: number[] = [0];
  for (const r of vm.all(`SELECT * FROM player_xp_for_level ORDER BY lvl`)) xpToNext[Number(r.lvl)] = Number(r.xp_for_next_level);
  const races = client.dbc('ChrRaces'), classes = client.dbc('ChrClasses');
  const raceList = races.rows().map(r => ({ id: races.u32(r, 0), name: races.str(r, 17) }));
  const cbi = client.dbc('CharBaseInfo'); // packed: byte 0 race, byte 1 class
  const raceClasses: Record<number, number[]> = {};
  for (const r of cbi.rows()) (raceClasses[cbi.u8(r, 0)] ??= []).push(cbi.u8(r, 1));
  // Weapon/armor skills each class may learn, and their names (SkillLine categories 6 weapons, 8 armor).
  const sl = client.dbc('SkillLine'); // 0 id, 1 category, 3 name
  const skillNames: Record<number, string> = {};
  for (const r of sl.rows()) if ([6, 8].includes(sl.u32(r, 1))) skillNames[sl.u32(r, 0)] = sl.str(r, 3);
  const srci = client.dbc('SkillRaceClassInfo'); // 1 skill, 2 raceMask, 3 classMask, 5 minLevel
  const classSkills: Record<number, Record<number, number>> = {};
  for (const r of srci.rows()) {
    const skill = srci.u32(r, 1), mask = srci.u32(r, 3), minLevel = srci.u32(r, 5);
    if (!skillNames[skill]) continue;
    for (let cls = 1; cls <= 11; cls++) {
      if (!(mask & (1 << (cls - 1)))) continue;
      const m = (classSkills[cls] ??= {});
      m[skill] = Math.min(m[skill] ?? 99, minLevel);
    }
  }

  const levelStats: GameData['levelStats'] = {};
  for (const r of vm.all(`SELECT * FROM player_levelstats ORDER BY race, class, level`)) {
    const race = Number(r.race), cls = Number(r.class);
    ((levelStats[race] ??= {})[cls] ??= [])[Number(r.level)] = [Number(r.str), Number(r.agi), Number(r.sta), Number(r.inte), Number(r.spi)];
  }
  const classStatsOut: GameData['classStats'] = {};
  for (const r of vm.all(`SELECT * FROM player_classlevelstats ORDER BY class, level`)) {
    (classStatsOut[Number(r.class)] ??= [])[Number(r.level)] = [Number(r.basehp), Number(r.basemana)];
  }

  const skillRanks = buildSkillRanks(vm);
  const usedFactions = new Set<number>([
    ...Object.values(quests).flatMap(q => q.rep.map(([f]) => f)),
    ...Object.values(creatures).flatMap(c => (c.rep ?? []).map(r => r.faction)),
    ...Object.values(itemDefs).flatMap(i => (i.reqRep ? [i.reqRep[0]] : [])),
  ]);
  const factions = buildFactions(client, usedFactions);

  // ---- class spells, and where each class's trainers are
  const { spells, classSpells } = buildClassSpells(client, vm, castTimes, durations);
  const { talents, talentTabs } = buildTalents(client, vm);
  const classTrainerZones: Record<number, number[]> = {};
  for (const z of zones) {
    for (const entry of acc.get(z.id)?.creatures.keys() ?? []) {
      const t = template(entry);
      if (!t || Number(t.trainer_type) !== 0 || !Number(t.trainer_class)) continue;
      const list = (classTrainerZones[Number(t.trainer_class)] ??= []);
      if (!list.includes(z.id)) list.push(z.id);
    }
  }
  for (const s of Object.values(spells)) for (const e of s.effects) if (e.k === 'conjure') items.add(e.item);
  for (const id of items) if (!itemDefs[id]) { const t = vm.cachedItem(id); if (t) itemDefs[id] = itemDef(t, icons, vm, durations); }
  log(`class spells: ${Object.keys(spells).length} spell ranks; trainers in ${new Set(Object.values(classTrainerZones).flat()).size} zones`);

  const loot = vm.tables;
  vm.close();
  const startZones: Record<number, number> = {};
  for (const [race, zone] of Object.entries(START_ZONES)) if (zones.some(z => z.id === zone)) startZones[+race] = zone;
  const data: GameData = {
    version: 2, builtAt: new Date().toISOString(), build: 5875,
    xpToNext, maxLevel: 60,
    races: raceList.filter(r => [1, 2, 3, 4, 5, 6, 7, 8].includes(r.id))
      .map(r => ({ ...r, faction: [1, 3, 4, 7].includes(r.id) ? 'alliance' as const : 'horde' as const })),
    classes: classes.rows().map(r => ({ id: classes.u32(r, 0), name: classes.str(r, 5) })),
    raceClasses, startZones, classSkills, skillNames, spells, classSpells, classTrainerZones, talents, talentTabs,
    levelStats, classStats: classStatsOut, skillRanks,
    zones, creatures, items: itemDefs, nodes, recipes, enchants, quests, factions, loot, taxiNodes, taxiPaths,
  };
  const out = path.join(opts.cacheDir, 'data');
  fs.mkdirSync(out, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(out, 'game.json'), json);
  log(`game.json: ${(json.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(itemDefs).length} items, ${Object.keys(loot).length} loot tables (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return data;
}

function addVendor(zone: ZoneDef, t: Row, vm: VMangos, items: Set<number>, seen: Set<number>, factions: Faction[]): void {
  if (!factions.length) return;
  const rows = [
    ...vm.all(`SELECT item FROM npc_vendor WHERE entry=?`, Number(t.entry)),
    ...(Number(t.vendor_id) ? vm.all(`SELECT item FROM npc_vendor_template WHERE entry=?`, Number(t.vendor_id)) : []),
  ];
  for (const r of rows) {
    const id = Number(r.item);
    const key = id * 4 + (factions.includes('alliance') ? 1 : 0) + (factions.includes('horde') ? 2 : 0);
    if (seen.has(key) || !vm.cachedItem(id)) continue;
    seen.add(key); items.add(id);
    zone.vendorItems.push({ item: id, vendor: String(t.name ?? ''), factions });
  }
}

function creatureDef(t: Row, classStats: Map<string, Row>, vm: VMangos, items: Set<number>, hostile: Faction[]): CreatureDef | null {
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
    ...(Number(t.skinning_loot_id) ? { skin: vm.loot('skinning_loot_template', Number(t.skinning_loot_id), items) ?? undefined } : {}),
    hostile,
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
    itemLevel: Number(t.item_level),
  };
  if (Number(t.required_reputation_faction)) def.reqRep = [Number(t.required_reputation_faction), Number(t.required_reputation_rank)];
  if (Number(t.disenchant_id) && def.quality >= 2) {
    const key = `de:${Number(t.disenchant_id)}`;
    if (vm.tables[key]) def.disenchant = key;
  }
  // Food and drink: an on-use aura that restores health/mana per tick over the aura duration.
  const spellId = Number(t.spellid_1);
  if (spellId && Number(t.spelltrigger_1) === 0) {
    const s = vm.spell(spellId);
    if (s) {
      const durationMs = durations.get(Number(s.durationIndex)) ?? 0;
      let heal = 0, mana = 0, potHeal = 0, potMana = 0;
      for (let e = 1; e <= 3; e++) {
        const effect = Number(s[`effect${e}`]), aura = Number(s[`effectApplyAuraName${e}`]);
        const bp = Number(s[`effectBasePoints${e}`]), avg = bp + 1 + Math.max(0, Number(s[`effectDieSides${e}`]) - 1) / 2;
        const total = Math.round((bp + 1) * durationMs / REGEN_TICK_MS);
        if (aura === AURA_MOD_REGEN) heal += total;
        if (aura === AURA_MOD_POWER_REGEN) mana += total;
        // Bandages: a channeled heal-over-time; idle, they work like food that only heals.
        if (aura === AURA_PERIODIC_HEAL && def.class === 0) heal += Math.round((bp + 1) * durationMs / (Number(s[`effectAmplitude${e}`]) || 1000));
        if (effect === EFFECT_HEAL) potHeal += Math.round(avg);
        if (effect === EFFECT_ENERGIZE && Number(s[`effectMiscValue${e}`]) === 0) potMana += Math.round(avg);
      }
      if (heal || mana) def.food = { heal, mana, durationMs };
      if ((potHeal || potMana) && def.class === 0) def.potion = { heal: potHeal, mana: potMana };
    }
  }
  if (def.id === 2901) def.tool = 'mining-pick';
  if (def.class === 2 && def.subclass === 20) def.tool = 'fishing-pole';
  if (def.id === 7005) def.tool = 'skinning-knife';
  return def;
}
