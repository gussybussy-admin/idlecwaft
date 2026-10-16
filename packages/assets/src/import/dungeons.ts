// Dungeons: the 5-man instances (LFGDungeons.dbc + Map.dbc), their creatures and bosses (VMaNGOS spawns),
// the order you meet them in, and the spells creatures cast (creature_spells) as boss mechanics.
//
// Bosses are found, not listed: elites that spawn exactly once in the instance and carry real loot.
// Instances that hold several runs (Scarlet Monastery, Dire Maul, Stratholme, Blackrock Spire) are split
// into wings around each wing's final boss; everything else in the instance joins its nearest wing.
import type { AbilityEffect, CreatureAbility, CreatureDef, DungeonDef, Encounter } from '@idle/sim';
import type { Client } from '../client.js';
import type { ZoneLookup } from './zone-lookup.js';
import { PATCH_1_12, type Row, type VMangos } from './vmangos.js';

/** Instances with several runs: each wing's name, LFG entry, final boss, group size. */
/** Instances with several runs: each wing's name, LFG entry, final boss, landmark bosses that mark its area, group size. */
const WINGS: Record<number, { name: string; lfg?: number; anchor: string; landmarks?: string[]; size?: number; level?: [number, number] }[]> = {
  189: [
    { name: 'Scarlet Monastery: Graveyard', anchor: 'Bloodmage Thalnos', level: [28, 38] },
    { name: 'Scarlet Monastery: Library', anchor: 'Arcanist Doan', level: [33, 40] },
    { name: 'Scarlet Monastery: Armory', anchor: 'Herod', level: [35, 43] },
    { name: 'Scarlet Monastery: Cathedral', anchor: 'High Inquisitor Whitemane', level: [37, 46] },
  ],
  429: [
    { name: 'Dire Maul: East', lfg: 33, anchor: 'Alzzin the Wildshaper', landmarks: ['Zevrim Thornhoof', 'Hydrospawn', 'Lethtendris'] },
    { name: 'Dire Maul: West', lfg: 35, anchor: 'Prince Tortheldrin', landmarks: ["Immol'thar", 'Tendris Warpwood', 'Magister Kalendris'] },
    { name: 'Dire Maul: North', lfg: 37, anchor: 'King Gordok', landmarks: ["Guard Mol'dar", 'Guard Fengus', "Guard Slip'kik", 'Captain Kromcrush', "Cho'Rush the Observer"] },
  ],
  329: [
    // Dathrohan becomes Balnazzar mid-fight
    { name: 'Stratholme: Live', lfg: 39, anchor: 'Grand Crusader Dathrohan', landmarks: ['Timmy the Cruel', 'Malor the Zealous', 'Archivist Galford', 'Cannon Master Willey'] },
    { name: 'Stratholme: Undead', lfg: 39, anchor: 'Baron Rivendare', landmarks: ['Baroness Anastari', "Nerub'enkan", 'Maleki the Pallid', 'Magistrate Barthilas', 'Ramstein the Gorger'] },
  ],
  229: [
    { name: 'Lower Blackrock Spire', lfg: 31, anchor: 'Overlord Wyrmthalak' },
    { name: 'Upper Blackrock Spire', lfg: 43, anchor: 'General Drakkisath', size: 10 },
  ],
};
/** LFG names that differ from Map.dbc names. */
const LFG_ALIASES: Record<string, string> = { 'Stormwind Stockades': 'Stormwind Stockade', "Zul'Farak": "Zul'Farrak" };

const PACK_RADIUS = 12;           // yards: spawns this close form one pull
const PACKS_PER_BOSS = 4;         // trash pulls kept before each boss (runs stay ~20-40 minutes)
const CREATURE_TYPE_CRITTER = 8;

interface Spawn { entry: number; x: number; y: number; z: number }

export interface DungeonInputs {
  creatureDef: (t: Row) => CreatureDef | null;
  creatures: Record<number, CreatureDef>;
  items: Set<number>;
}

export function buildDungeons(client: Client, vm: VMangos, zl: ZoneLookup, inp: DungeonInputs): Record<number, DungeonDef> {
  const map = client.dbc('Map'); // 0 id, 2 instance type (1 party), 4 name
  const mapByName = new Map<string, number>();
  for (const r of map.rows()) if (map.u32(r, 2) === 1) mapByName.set(map.str(r, 4), map.u32(r, 0));
  const lfg = client.dbc('LFGDungeons'); // 1 name, 10 min, 11 max, 12 type (1 dungeon, 2 raid)
  const lfgById = new Map<number, { name: string; min: number; max: number }>();
  const runs: { map: number; name: string; min: number; max: number; size: number; anchor?: string; lfg: number }[] = [];
  for (const r of lfg.rows()) {
    const type = lfg.u32(r, 12), id = lfg.u32(r, 0), name = lfg.str(r, 1);
    lfgById.set(id, { name, min: lfg.u32(r, 10), max: lfg.u32(r, 11) });
    if (type !== 1) continue;
    const mapId = mapByName.get(LFG_ALIASES[name] ?? name)
      ?? (name.startsWith('Dire Maul') ? 429 : name === 'Lower Blackrock Spire' ? 229 : undefined);
    if (mapId === undefined || WINGS[mapId]) continue;
    runs.push({ map: mapId, name, min: lfg.u32(r, 10), max: lfg.u32(r, 11), size: 5, lfg: id });
  }
  for (const [mapId, wings] of Object.entries(WINGS)) {
    wings.forEach((w, i) => {
      const l = w.lfg ? lfgById.get(w.lfg) : undefined;
      const [min, max] = w.level ?? [l?.min ?? 1, l?.max ?? 60];
      runs.push({ map: +mapId, name: w.name, min, max, size: w.size ?? 5, anchor: w.anchor, lfg: (w.lfg ?? 17) * 100 + i });
    });
  }

  // The world zone each instance's portal stands in.
  const portalZone = new Map<number, number>();
  for (const t of vm.all(`SELECT a.map_id, a.x, a.y, p.target_map FROM areatrigger_teleport p JOIN areatrigger_template a ON a.id = p.id`)) {
    const z = zl.zoneAt(Number(t.map_id), Number(t.x), Number(t.y));
    if (z && !portalZone.has(Number(t.target_map))) portalZone.set(Number(t.target_map), z);
  }

  const tmpl = new Map<number, Row | undefined>();
  const template = (e: number) => { if (!tmpl.has(e)) tmpl.set(e, vm.creatureTemplate(e)); return tmpl.get(e); };
  const spawnsByMap = new Map<number, Spawn[]>();
  for (const s of vm.all(`SELECT id, map, position_x x, position_y y, position_z z FROM creature WHERE map IN (${[...new Set(runs.map(r => r.map))].join(',')})
    AND patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12)) {
    (spawnsByMap.get(Number(s.map)) ?? spawnsByMap.set(Number(s.map), []).get(Number(s.map))!)
      .push({ entry: Number(s.id), x: Number(s.x), y: Number(s.y), z: Number(s.z) });
  }

  // A creature worth fighting in an instance: hostile, not a critter or NPC, with stats we can build.
  const fightable = (entry: number): CreatureDef | null => {
    if (inp.creatures[entry]) return inp.creatures[entry];
    const t = template(entry);
    // Hostile creatures that also talk (gossip 1, quest giver 2) still fight; vendors, trainers and the like do not.
    if (!t || (Number(t.npc_flags) & ~3) || Number(t.type) === CREATURE_TYPE_CRITTER) return null;
    const def = inp.creatureDef(t);
    if (!def || def.hostile.length === 0) return null;
    def.abilities = abilities(vm, t);
    inp.creatures[entry] = def;
    return def;
  };
  /**
   * Boss: an elite that spawns once in the instance and shows it in the data — a rare elite, an encounter
   * script, a guaranteed gear drop (early bosses drop one item for sure: Rhahk'Zor's hammer), at least two
   * uncommon-or-better items that really drop (≥3%, following references), or a quest item. Trash only
   * reaches good items through tiny world-drop chances.
   */
  const isBoss = (def: CreatureDef, spawns: number) => {
    if (spawns !== 1 || def.rank === 0) return false;
    if (def.rank === 2 || def.rank === 4) return true;
    const script = String(template(def.id)?.script_name ?? '');
    if (script && /^(boss_|npc_)/.test(script) && def.loot) return true;
    if (!def.loot) return false;
    const good = new Set<number>();
    let guaranteedGear = false, questDrop = false;
    const isGear = (item: number) => { const t = vm.cachedItem(item); return !!t && (Number(t.class) === 2 || Number(t.class) === 4); };
    const walk = (ref: string, scale: number, depth: number) => {
      const t = vm.tables[ref];
      if (!t || depth > 4) return;
      const visit = (e: (typeof t.entries)[number], chance: number) => {
        if ('item' in e) {
          if ('quest' in e && e.quest) questDrop = true;
          if (chance * scale >= 3 && Number(vm.cachedItem(e.item)?.quality) >= 2) good.add(e.item);
        } else walk(e.ref, scale * Math.min(100, chance * Math.max(1, e.times)) / 100, depth + 1);
      };
      for (const e of t.entries) visit(e, e.chance);
      for (const g of t.groups) {
        const explicit = g.reduce((a, e) => a + e.chance, 0), even = g.filter(e => !e.chance).length;
        const sure = scale >= 0.99 && (explicit >= 99 || even > 0);
        if (sure && g.some(e => 'item' in e && isGear(e.item))) guaranteedGear = true;
        for (const e of g) visit(e, e.chance || (even ? Math.max(0, 100 - explicit) / even : 0));
      }
    };
    walk(def.loot, 1, 0);
    return guaranteedGear || questDrop || good.size >= 2;
  };

  const out: Record<number, DungeonDef> = {};
  for (const run of runs) {
    const all = spawnsByMap.get(run.map) ?? [];
    const counts = new Map<number, number>();
    for (const s of all) counts.set(s.entry, (counts.get(s.entry) ?? 0) + 1);
    // Which wing each spawn belongs to: the wing of the nearest anchor or landmark (3D).
    const wings = WINGS[run.map];
    let spawns = all;
    if (wings) {
      const find = (name: string) => all.find(s => template(s.entry)?.name === name) ?? null;
      const marks = wings.flatMap((w, i) => [w.anchor, ...(w.landmarks ?? [])].map(n => ({ at: find(n), wing: i }))).filter(m => m.at);
      const mine = wings.findIndex(w => w.name === run.name);
      if (!find(wings[mine].anchor)) continue;
      spawns = all.filter(s => {
        let best = -1, bd = Infinity;
        for (const m of marks) { const d = dist(m.at!, s); if (d < bd) { bd = d; best = m.wing; } }
        return best === mine;
      });
    }
    const bosses: Spawn[] = [], trash: Spawn[] = [];
    for (const s of spawns) {
      const def = fightable(s.entry);
      if (!def) continue;
      (isBoss(def, counts.get(s.entry) ?? 0) ? bosses : trash).push(s);
    }
    if (!bosses.length) continue;
    // Order: from the entrance (the trash spawn farthest from the final boss) toward the final boss.
    const finalBoss = run.anchor ? bosses.find(b => template(b.entry)?.name === run.anchor) ?? bosses[bosses.length - 1]
      : bosses.reduce((a, b) => (template(b.entry)!.level_max as number) > (template(a.entry)!.level_max as number) ? b : a);
    const start = [...trash, ...bosses].reduce((a, b) => (dist(b, finalBoss) > dist(a, finalBoss) ? b : a));
    bosses.sort((a, b) => (a === finalBoss ? 1 : b === finalBoss ? -1 : dist(start, a) - dist(start, b)));
    // Trash packs, each assigned to the next boss it guards.
    const packs = cluster(trash);
    const encounters: Encounter[] = [];
    bosses.forEach((b, i) => {
      const prev = i ? bosses[i - 1] : start;
      const mine = packs.filter(p => nearestIndex(bosses, p.center) === i)
        .sort((x, y) => dist(prev, x.center) - dist(prev, y.center));
      for (const p of pickEvenly(mine, PACKS_PER_BOSS)) encounters.push({ mobs: tally(p.members.slice(0, 4)) });
      encounters.push({ boss: b.entry, mobs: [[b.entry, 1]] });
    });
    out[run.lfg] = {
      id: run.lfg, name: run.name, map: run.map, zone: portalZone.get(run.map) ?? null,
      minLevel: run.min, maxLevel: run.max, size: run.size, encounters,
    };
  }
  return out;
}

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 2); // floors are far apart even when close in x/y

function nearestIndex(list: Spawn[], p: { x: number; y: number; z: number }): number {
  let best = 0, bd = Infinity;
  list.forEach((s, i) => { const d = dist(s, p); if (d < bd) { bd = d; best = i; } });
  return best;
}

function cluster(spawns: Spawn[]): { members: number[]; center: { x: number; y: number; z: number } }[] {
  const left = [...spawns];
  const out: { members: number[]; center: { x: number; y: number; z: number } }[] = [];
  while (left.length) {
    const seed = left.shift()!;
    const group = [seed];
    for (let i = left.length - 1; i >= 0; i--) if (dist(left[i], seed) < PACK_RADIUS) group.push(...left.splice(i, 1));
    const c = group.reduce((a, s) => ({ x: a.x + s.x / group.length, y: a.y + s.y / group.length, z: a.z + s.z / group.length }), { x: 0, y: 0, z: 0 });
    out.push({ members: group.map(s => s.entry), center: c });
  }
  return out;
}

function pickEvenly<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor((i + 0.5) * list.length / n)]);
}

function tally(entries: number[]): [number, number][] {
  const m = new Map<number, number>();
  for (const e of entries) m.set(e, (m.get(e) ?? 0) + 1);
  return [...m];
}

// ---------------------------------------------------------------- creature spells → abilities

const SPELL_EFFECT = { DAMAGE: 2, HEAL: 10, EXTRA_ATTACKS: 19, SUMMON: 28, APPLY_AURA: 6, KNOCK_BACK: 98, WEAPON_DAMAGE: 58, NORMALIZED: 121, PERCENT_WEAPON: 31 };
const AURA = { PERIODIC_DAMAGE: 3, STUN: 12, FEAR: 7, CONFUSE: 5, ROOT: 26, MOD_DAMAGE_DONE: 79, MELEE_HASTE: 138, MOD_DAMAGE_PCT: 79 };
const SELF_TARGETS = new Set([1]);
// castTarget in creature_spells: 0 current victim, 1-4 other/random hostiles, others mostly self or friends.
const castTargetOf = (v: number): CreatureAbility['target'] => (v === 0 ? 'tank' : v <= 4 ? 'random' : 'self');

function abilities(vm: VMangos, t: Row): CreatureAbility[] | undefined {
  const id = Number(t.spell_list_id);
  if (!id) return undefined;
  const list = vm.get(`SELECT * FROM creature_spells WHERE entry=?`, id);
  if (!list) return undefined;
  const out: CreatureAbility[] = [];
  for (let i = 1; i <= 8; i++) {
    const spellId = Number(list[`spellId_${i}`]);
    if (!spellId) continue;
    const s = vm.spell(spellId);
    if (!s) continue;
    const effects = spellEffects(s);
    if (!effects.length) continue;
    const self = SELF_TARGETS.has(Number(s.effectImplicitTargetA1)) && !effects.some(e => e.k === 'damage' || e.k === 'dot' || e.k === 'cc');
    const aoe = [1, 2, 3].some(e => Number(s[`effectRadiusIndex${e}`]) > 0 && Number(s[`effectImplicitTargetA${e}`]) !== 1)
      || Number(s.effectImplicitTargetA1) === 22 || Number(s.effectImplicitTargetA1) === 15;
    out.push({
      spell: spellId, name: String(s.name), aoe,
      target: self ? 'self' : castTargetOf(Number(list[`castTarget_${i}`])),
      firstMs: [Number(list[`delayInitialMin_${i}`]) * 1000, Number(list[`delayInitialMax_${i}`]) * 1000],
      repeatMs: [Math.max(3, Number(list[`delayRepeatMin_${i}`])) * 1000, Math.max(3, Number(list[`delayRepeatMax_${i}`])) * 1000],
      chance: Number(list[`probability_${i}`]) || 100,
      effects,
    });
  }
  return out.length ? out : undefined;
}

function spellEffects(s: Row): AbilityEffect[] {
  const n = (k: string) => Number(s[k] ?? 0);
  const out: AbilityEffect[] = [];
  const school = n('school');
  for (let e = 1; e <= 3; e++) {
    const effect = n(`effect${e}`), aura = n(`effectApplyAuraName${e}`);
    const bp = n(`effectBasePoints${e}`), dice = Math.max(1, n(`effectDieSides${e}`));
    switch (effect) {
      case SPELL_EFFECT.DAMAGE: out.push({ k: 'damage', school, min: bp + 1, max: bp + dice }); break;
      case SPELL_EFFECT.WEAPON_DAMAGE: case SPELL_EFFECT.NORMALIZED: out.push({ k: 'damage', school: 0, min: bp + 1, max: bp + dice }); break;
      case SPELL_EFFECT.HEAL: out.push({ k: 'heal', amount: bp + 1 }); break;
      case SPELL_EFFECT.EXTRA_ATTACKS: out.push({ k: 'extraAttacks', n: Math.max(1, bp + 1) }); break;
      case SPELL_EFFECT.SUMMON: if (n(`effectMiscValue${e}`)) out.push({ k: 'summon', creature: n(`effectMiscValue${e}`), count: Math.max(1, bp + 1) }); break;
      case SPELL_EFFECT.KNOCK_BACK: out.push({ k: 'knockback' }); break;
      case SPELL_EFFECT.APPLY_AURA:
        if (aura === AURA.PERIODIC_DAMAGE) out.push({ k: 'dot', school, perTick: bp + 1, ticks: 5, ampMs: n(`effectAmplitude${e}`) || 3000 });
        else if (aura === AURA.STUN || aura === AURA.FEAR || aura === AURA.CONFUSE) out.push({ k: 'cc', ms: 4000 });
        else if ((aura === AURA.MOD_DAMAGE_DONE || aura === AURA.MELEE_HASTE) && bp + 1 > 0) out.push({ k: 'enrage', pct: Math.min(150, bp + 1) });
        break;
    }
  }
  return out;
}
