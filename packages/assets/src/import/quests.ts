// Quests (quest_template + giver/ender relations) and the reputations they and kills touch (Faction.dbc).
import type { CreatureDef, Faction, FactionDef, Profession, QuestDef, ZoneDef } from '@idle/sim';
import type { Client } from '../client.js';
import { PATCH_1_12, type Row, type VMangos } from './vmangos.js';
import { SKILL_LINE } from './professions.js';

const ALLIANCE_RACES = 1 | 4 | 8 | 64, HORDE_RACES = 2 | 16 | 32 | 128;
// Quest types idle play can't do yet: PvP, raid, dungeon, world event (dungeons and raids arrive in Phases 5-6).
const SKIP_TYPES = new Set([41, 62, 81, 82]);
const METHOD_DISABLED = 1;
const ITEM_CLASS_QUEST = 12;
const TASK_MAX_MS = 10 * 60_000;

export interface QuestInputs {
  creatures: Record<number, CreatureDef>;
  zones: ZoneDef[];
  /** Where each NPC / object stands (zone with most spawns). */
  npcZone: Map<number, number>;
  goZone: Map<number, number>;
  /** Items the idle world produces (drops, gathering, vendors, crafting): collect objectives use these. */
  collectable: Set<number>;
  /** Sides an NPC with this faction template will deal with. */
  traders: (factionTemplate: number) => Faction[];
  /** Item ids referenced by rewards get added here (so item definitions are built for them). */
  items: Set<number>;
}

export function buildQuests(vm: VMangos, inp: QuestInputs): Record<number, QuestDef> {
  const zoneIds = new Set(inp.zones.map(z => z.id));
  const profOf = new Map(Object.entries(SKILL_LINE).map(([k, v]) => [v, k as Profession]));
  const rel = (table: string) => {
    const m = new Map<number, number[]>();
    for (const r of vm.all(`SELECT id, quest FROM ${table} WHERE patch_min<=? AND patch_max>=?`, PATCH_1_12, PATCH_1_12)) {
      (m.get(Number(r.quest)) ?? m.set(Number(r.quest), []).get(Number(r.quest))!).push(Number(r.id));
    }
    return m;
  };
  const npcGivers = rel('creature_questrelation'), npcEnders = rel('creature_involvedrelation');
  const goGivers = rel('gameobject_questrelation'), goEnders = rel('gameobject_involvedrelation');
  const nameOf = new Map<number, Row | undefined>();
  const npc = (e: number) => { if (!nameOf.has(e)) nameOf.set(e, vm.creatureTemplate(e)); return nameOf.get(e); };
  /** First giver/ender that stands in a playable zone: [zone, name, sides]. */
  const place = (npcs: number[] | undefined, gos: number[] | undefined): [number, string, Faction[]] | null => {
    for (const id of npcs ?? []) {
      const z = inp.npcZone.get(id);
      const t = npc(id);
      if (z && zoneIds.has(z) && t) return [z, String(t.name), inp.traders(Number(t.faction))];
    }
    for (const id of gos ?? []) {
      const z = inp.goZone.get(id);
      const t = vm.gameobjectTemplate(id);
      if (z && zoneIds.has(z) && t) return [z, String(t.name), ['alliance', 'horde']];
    }
    return null;
  };

  const quests: Record<number, QuestDef> = {};
  const rows = vm.all(`SELECT * FROM quest_template q WHERE patch = (SELECT MAX(patch) FROM quest_template WHERE entry = q.entry AND patch <= ?)`, PATCH_1_12);
  for (const q of rows) {
    const n = (k: string) => Number(q[k] ?? 0);
    const id = n('entry');
    if (n('Method') === METHOD_DISABLED || SKIP_TYPES.has(n('Type'))) continue;
    const start = place(npcGivers.get(id), goGivers.get(id));
    if (!start) continue; // started by an item, a script, or someone outside the idle world
    const end = place(npcEnders.get(id), goEnders.get(id)) ?? start;
    const raceMask = n('RequiredRaces');
    let sides: Faction[] = raceMask
      ? (['alliance', 'horde'] as Faction[]).filter(f => raceMask & (f === 'alliance' ? ALLIANCE_RACES : HORDE_RACES))
      : start[2];
    sides = sides.filter(f => end[2].includes(f));
    if (!sides.length) continue;

    const kills: [number, number][] = [], items: [number, number][] = [];
    let taskMs = 0, impossible = false;
    const taskBits: string[] = [], grants: [number, number][] = [];
    for (let i = 1; i <= 4; i++) {
      const target = n(`ReqCreatureOrGOId${i}`), count = n(`ReqCreatureOrGOCount${i}`);
      if (target && count) {
        if (target > 0 && inp.creatures[target] && !n(`ReqSpellCast${i}`)) kills.push([target, count]);
        else {
          // Objects to use, spells to cast on someone, or enemies the idle world doesn't spawn.
          taskMs += count * (target > 0 ? 25_000 : 15_000);
          const label = String(q[`ObjectiveText${i}`] ?? '').trim()
            || (target > 0 ? `Deal with ${npc(target)?.name ?? 'the target'}` : `Use ${vm.gameobjectTemplate(-target)?.name ?? 'the object'}`);
          taskBits.push(count > 1 ? `${label} (${count})` : label);
        }
      }
      const item = n(`ReqItemId${i}`), icount = n(`ReqItemCount${i}`);
      if (item && icount) {
        items.push([item, icount]);
        inp.items.add(item);
        if (!inp.collectable.has(item)) {
          // Only quest items can be handed over by a task; anything else (a mount's bridle, a trophy) has to be earned.
          if (Number(vm.cachedItem(item)?.class) !== ITEM_CLASS_QUEST) { impossible = true; break; }
          // Nothing in the idle world drops it (a crate, a plant by the road): the task hands it over.
          taskMs += icount * 20_000;
          grants.push([item, icount]);
          taskBits.push(`Find ${vm.cachedItem(item)?.name ?? 'the items'}`);
        }
      }
    }
    if (impossible) continue;
    if (!kills.length && !items.length && !taskBits.length) {
      // Talk to, deliver, explore: the walk is the task.
      taskMs += 30_000 + n('QuestLevel') * 3_000;
      taskBits.push(end[0] !== start[0] ? `Travel to ${end[1]}` : `Speak with ${end[1]}`);
    } else if (taskBits.length) taskMs += 30_000;

    const pairs = (idKey: string, countKey: string, max: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 1; i <= max; i++) if (n(`${idKey}${i}`)) { out.push([n(`${idKey}${i}`), Math.max(1, n(`${countKey}${i}`))]); inp.items.add(n(`${idKey}${i}`)); }
      return out;
    };
    const rep: [number, number][] = [];
    for (let i = 1; i <= 5; i++) if (n(`RewRepFaction${i}`) && n(`RewRepValue${i}`)) rep.push([n(`RewRepFaction${i}`), n(`RewRepValue${i}`)]);
    const prof = profOf.get(n('RequiredSkill'));
    const prev = Math.abs(n('PrevQuestId'));
    quests[id] = {
      id, name: String(q.Title), level: Math.max(1, n('QuestLevel')), minLevel: n('MinLevel'),
      zone: start[0], endZone: end[0], giver: start[1], ender: end[1],
      races: raceMask, classes: n('RequiredClasses'), sides,
      ...(prof ? { skill: [prof, n('RequiredSkillValue')] as [Profession, number] } : {}),
      ...(prev ? { prev } : {}),
      ...(n('ExclusiveGroup') > 0 ? { exclusive: n('ExclusiveGroup') } : {}),
      ...(n('NextQuestInChain') ? { next: n('NextQuestInChain') } : {}),
      kills, items,
      ...(taskBits.length ? { task: { ms: Math.min(TASK_MAX_MS, taskMs), label: taskBits.join('; '), grants } } : {}),
      xp: n('RewXP'), money: Math.max(0, n('RewOrReqMoney')), moneyMax: n('RewMoneyMaxLevel'),
      rewItems: pairs('RewItemId', 'RewItemCount', 4), choice: pairs('RewChoiceItemId', 'RewChoiceItemCount', 6),
      rep, objectives: cleanText(String(q.Objectives ?? '')),
    };
  }
  // Quests that give nothing and lead nowhere are dropped (paperwork for things idle play skips).
  const leadsOn = new Set(Object.values(quests).flatMap(q => (q.prev ? [q.prev] : [])));
  for (const q of Object.values(quests)) {
    if (!q.xp && !q.money && !q.rewItems.length && !q.choice.length && !q.rep.length && !leadsOn.has(q.id)) delete quests[q.id];
  }
  // A follow-up whose prerequisite didn't make it in can still be taken.
  for (const q of Object.values(quests)) if (q.prev && !quests[q.prev]) delete q.prev;
  return quests;
}

/** Objective text with the client's $N/$C/$R/$G tokens resolved to something neutral. */
function cleanText(t: string): string {
  return t.replace(/\$[Nn]/g, 'adventurer').replace(/\$[Cc]/g, 'hero').replace(/\$[Rr]/g, 'traveller')
    .replace(/\$[Gg]([^:;]*):([^;]*);/g, '$1').replace(/\$B/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Factions players can earn standing with, with their starting standing per race. */
export function buildFactions(client: Client, used: Set<number>): Record<number, FactionDef> {
  const fac = client.dbc('Faction'); // 0 id, 1 repIndex, 2-5 raceMask, 10-13 base, 18 parent, 19 name
  const out: Record<number, FactionDef> = {};
  for (const r of fac.rows()) {
    const id = fac.u32(r, 0);
    if (!used.has(id) || fac.i32(r, 1) < 0) continue;
    const base: Record<number, number> = {};
    for (let race = 1; race <= 8; race++) {
      for (let i = 0; i < 4; i++) if (fac.u32(r, 2 + i) & (1 << (race - 1))) { base[race] = fac.i32(r, 10 + i); break; }
      base[race] ??= 0;
    }
    out[id] = { id, name: fac.str(r, 19), parent: fac.u32(r, 18), base };
  }
  return out;
}

/** Reputation for killing each creature (creature_onkill_reputation). */
export function killReputation(vm: VMangos): Map<number, NonNullable<CreatureDef['rep']>> {
  const out = new Map<number, NonNullable<CreatureDef['rep']>>();
  for (const r of vm.all(`SELECT * FROM creature_onkill_reputation o WHERE patch = (SELECT MAX(patch) FROM creature_onkill_reputation WHERE creature_id = o.creature_id AND patch <= ?)`, PATCH_1_12)) {
    const list: NonNullable<CreatureDef['rep']> = [];
    const team = Number(r.TeamDependent) === 1;
    for (const i of [1, 2]) {
      const faction = Number(r[`RewOnKillRepFaction${i}`]), value = Number(r[`RewOnKillRepValue${i}`]);
      if (!faction || !value) continue;
      list.push({ faction, value, maxRank: Number(r[`MaxStanding${i}`]) || 7, ...(team ? { side: i === 1 ? 'alliance' as const : 'horde' as const } : {}) });
    }
    if (list.length) out.set(Number(r.creature_id), list);
  }
  return out;
}
