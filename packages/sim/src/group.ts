// The group simulation: a dungeon run resolved from member snapshots by a seeded, deterministic sim.
//
// Each member is a snapshot (taken when the run starts): role, health, armor and avoidance, resistances,
// damage per second measured by fighting a training dummy with their real spells, talents and gear,
// and their best heal. Pulls run in 1-second steps: the tank holds the mobs, the healer heals, damage
// dealers kill; creature abilities (from their spell lists) hit tanks, random members or everyone, and
// are reduced by resistances. Members rest between pulls; a wiped pull is retried twice before the
// run fails. The event log is the replay.
import type { CreatureDef, GameData, ItemDef } from './data.js';
import { HUNTER, TAME_LEVEL } from './pets.js';
import { factionOfRace } from './data.js';
import type { AbilityEffect, CreatureAbility, DungeonDef } from './dungeons.js';
import { advance, equipSlots, grantXp, playerStats, proficiencyFor, type SimEvent } from './engine.js';
import { activeTalentEffects } from './talents.js';
import { knownSpells, modded } from './combat.js';
import { scaled } from './spells.js';
import { armorReduction, killXp, missChance, SKILL_DEFENSE } from './formulas.js';
import { rollLoot } from './loot.js';
import { chance, int, next, seedRng, type RngState } from './rng.js';
import { addItem, log, newGame, SLOTS, type Appearance, type GameState, type Slot } from './state.js';
import { creditKill, neededQuestItems } from './quests.js';

export type Role = 'tank' | 'healer' | 'dps';
export const ROLES: Role[] = ['tank', 'healer', 'dps'];
/** Classes that can take each role (by class id). */
export const ROLE_CLASSES: Record<Role, number[]> = { tank: [1, 2, 11], healer: [2, 5, 7, 11], dps: [1, 2, 3, 4, 5, 7, 8, 9, 11] };

export interface Snapshot {
  /** Account id for players, null for hirelings. */
  accountId: number | null;
  name: string; race: number; cls: number; level: number; role: Role;
  look?: Appearance;
  gear: { displayId: number; invType: number; slot: string }[];
  maxHp: number; armor: number; dodge: number; defense: number;
  /** Shield block value (tanks with a shield block part of a hit). */
  block?: number;
  /** Resistances by school index (1 holy .. 6 arcane). */
  resist: number[];
  dps: number;
  /** Spammable heals, cheapest first (healers down-rank to fit the damage). */
  heals: Heal[];
  maxMana: number; manaPerSec: number;
  hireling?: boolean;
  /** Up to two items this member wants from the loot table: a targeted drop goes to them. */
  targets?: number[];
  /** Potions brought along: healing (`heal`) or protection (`school` absorb), and how many. */
  potions?: { item: number; heal?: number; mana?: number; school?: number; amount: number; count: number }[];
  /** Elixirs and flasks drunk for the run (item ids), already counted into the numbers above. */
  elixirs?: number[];
}

/** How many targets a member may set per run. */
export const MAX_TARGETS = 2;
const POTIONS_EACH = 5;

const DUMMY = -1;
const MEASURE_MS = 40_000; // about one pull: casters drink between pulls

/** Damage per second of a character against a target of `level`, measured with the real fight engine. */
export function measureDps(s: GameState, data: GameData, level: number): number {
  const dummy: CreatureDef = {
    id: DUMMY, name: 'Training Dummy', subname: '', levelMin: level, levelMax: level, rank: 0, type: 7, displayIds: [],
    attackMs: 60_000, stats: [{ hp: 1e9, dmgMin: 1, dmgMax: 1, armor: level * 30 }], goldMin: 0, goldMax: 0, loot: null, hostile: ['alliance', 'horde'],
  };
  const d: GameData = { ...data, creatures: { ...data.creatures, [DUMMY]: dummy } };
  const c: GameState = JSON.parse(JSON.stringify(s));
  c.char.hp = playerStats(c, d).maxHp;
  c.char.mana = playerStats(c, d).maxMana;
  c.action = { kind: 'fight', creature: DUMMY };
  c.phase = { p: 'idle' };
  let dmg = 0, from = -1;
  advance(c, d, c.now + MEASURE_MS, (e: SimEvent) => {
    if (e.type === 'spawn' && from < 0) from = e.t;
    if (e.type === 'swing' && (e.who === 'player' || e.who === 'pet') && e.target !== 'pet') dmg += e.dmg;
  });
  const secs = (c.now - (from < 0 ? c.now : from)) / 1000;
  return secs > 0 ? Math.round(dmg / secs) : 0;
}

export interface Heal { amount: number; castMs: number; cost: number }

/** Every spammable heal rank a character knows (amount, cast time and cost after talents), cheapest first. */
function healsOf(s: GameState, data: GameData): Heal[] {
  const tal = activeTalentEffects(s, data);
  const out: Heal[] = [];
  for (const sp of knownSpellRanks(s, data)) {
    // Spammable heals only: long-cooldown heals (Desperate Prayer, Lay on Hands) are emergency buttons.
    if (sp.cooldownMs > 10_000 || !sp.cost) continue;
    for (const e of sp.effects) {
      if (e.k !== 'heal') continue;
      const m = modded(sp, tal);
      const amount = Math.round(scaled(e.base + e.dice / 2, e.perLevel, sp, s.char.level) * m.dmgMult);
      out.push({ amount, castMs: Math.max(1500, m.castMs), cost: m.cost });
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** All learned ranks of every spell (healers keep low ranks for cheap top-ups). */
function knownSpellRanks(s: GameState, data: GameData) {
  return (s.spells ?? []).map(id => data.spells?.[id]).filter((sp): sp is NonNullable<typeof sp> => !!sp && sp.spellLevel <= s.char.level);
}

export function snapshotOf(s: GameState, data: GameData, accountId: number | null, role: Role, targetLevel: number,
  opts: { targets?: number[]; consumables?: boolean } = {}): Snapshot {
  const st = playerStats(s, data);
  const resist = [0, 0, 0, 0, 0, 0, 0];
  const gear: Snapshot['gear'] = [];
  for (const slot of SLOTS) {
    const it = s.equipment[slot] ? data.items[s.equipment[slot]!] : undefined;
    if (!it) continue;
    it.resist?.forEach((v, i) => { resist[i] += v; });
    if (it.displayId) gear.push({ displayId: it.displayId, invType: it.invType, slot });
  }
  const snap: Snapshot = {
    accountId, name: s.char.name, race: s.char.race, cls: s.char.cls, level: s.char.level, role,
    ...(s.char.look ? { look: s.char.look } : {}), gear,
    maxHp: st.maxHp, armor: st.armor, dodge: st.dodge, defense: s.combatSkills[SKILL_DEFENSE] ?? s.char.level * 5,
    ...(s.equipment.offhand && data.items[s.equipment.offhand]?.block ? { block: data.items[s.equipment.offhand]!.block! + Math.round(st.str / 20) } : {}),
    resist, dps: measureDps(s, data, targetLevel),
    heals: role === 'healer' ? healsOf(s, data) : [],
    maxMana: st.maxMana, manaPerSec: Math.max(1, st.maxMana / 120),
    ...(opts.targets?.length ? { targets: opts.targets.slice(0, MAX_TARGETS) } : {}),
  };
  if (opts.consumables) bringConsumables(s, data, snap);
  return snap;
}

/**
 * Consumables from the bags: the two best elixirs/flasks for the role are drunk (counted into the
 * snapshot), and healing and protection potions are packed to be used in the fights.
 */
function bringConsumables(s: GameState, data: GameData, snap: Snapshot): void {
  const owned = Object.entries(s.inventory).map(([id, n]) => [data.items[+id], n] as const).filter(([it]) => it);
  const statScore = (stats: [number, number][], want: number[]) => stats.reduce((a, [t, v]) => a + (want.includes(t) ? v * 3 : v), 0);
  const want = snap.role === 'tank' ? [7, 4, 3] : snap.role === 'healer' ? [5, 6] : snap.cls === 8 || snap.cls === 5 || snap.cls === 9 ? [5, 6] : [4, 3];
  const elixirs = owned.filter(([it]) => it!.elixir).map(([it]) => {
    const e = it!.elixir!;
    const score = statScore(e.stats, want) + (snap.role === 'tank' ? e.hp / 5 + e.armor / 20 : e.hp / 20) + e.ap / 2 + e.resist.reduce((a, v) => a + v, 0) / 4;
    return { it: it!, score };
  }).sort((a, b) => b.score - a.score).slice(0, 2);
  for (const { it } of elixirs) {
    const e = it.elixir!;
    const sta = e.stats.filter(([t]) => t === 7).reduce((a, [, v]) => a + v, 0);
    const str = e.stats.filter(([t]) => t === 4).reduce((a, [, v]) => a + v, 0);
    const agi = e.stats.filter(([t]) => t === 3).reduce((a, [, v]) => a + v, 0);
    snap.maxHp += e.hp + sta * 10;
    snap.armor += e.armor + agi * 2;
    e.resist.forEach((v, i) => { snap.resist[i] += v; });
    if (snap.role !== 'healer') snap.dps += Math.round((e.ap + str * 2 + agi * 2) / 14);
    if (snap.role === 'healer') snap.maxMana += e.stats.filter(([t]) => t === 5).reduce((a, [, v]) => a + v * 15, 0);
  }
  snap.elixirs = elixirs.map(e => e.it.id);
  const potions: NonNullable<Snapshot['potions']> = [];
  const heals = owned.filter(([it]) => it!.potion?.heal).sort((a, b) => b[0]!.potion!.heal - a[0]!.potion!.heal);
  if (heals[0]) potions.push({ item: heals[0][0]!.id, heal: heals[0][0]!.potion!.heal, amount: heals[0][0]!.potion!.heal, count: Math.min(POTIONS_EACH, heals[0][1]) });
  for (const [it, n] of owned) if (it!.protection) potions.push({ item: it!.id, school: it!.protection.school, amount: it!.protection.amount, count: Math.min(POTIONS_EACH, n) });
  const manas = owned.filter(([it]) => it!.potion?.mana && !it!.potion.heal).sort((a, b) => b[0]!.potion!.mana - a[0]!.potion!.mana);
  if (manas[0] && snap.maxMana) potions.push({ item: manas[0][0]!.id, mana: manas[0][0]!.potion!.mana, amount: manas[0][0]!.potion!.mana, count: Math.min(POTIONS_EACH, manas[0][1]) });
  if (potions.length) snap.potions = potions;
}

// Hirelings: a level-appropriate member of the role, trained in every spell, in modest gear.
const HIRELING: Record<Role, { cls: number; name: string; race: Record<'alliance' | 'horde', number> }> = {
  tank: { cls: 1, name: 'Hired Shieldbearer', race: { alliance: 3, horde: 2 } },
  healer: { cls: 5, name: 'Hired Priest', race: { alliance: 1, horde: 5 } },
  dps: { cls: 8, name: 'Hired Battlemage', race: { alliance: 7, horde: 8 } },
};
/** Hired damage dealers come in every class, in turn. */
const DPS_HIRELINGS: { cls: number; name: string; race: Record<'alliance' | 'horde', number> }[] = [
  HIRELING.dps,
  { cls: 4, name: 'Hired Cutthroat', race: { alliance: 1, horde: 2 } },
  { cls: 9, name: 'Hired Shadowcaller', race: { alliance: 7, horde: 5 } },
  { cls: 3, name: 'Hired Marksman', race: { alliance: 3, horde: 8 } },
  { cls: 1, name: 'Hired Blademaster', race: { alliance: 1, horde: 2 } },
];
/** Hirelings are paid help: weaker than a geared player, but enough that two friends can run a dungeon. */
export const HIRELING_POWER = 0.8;

export function hireling(data: GameData, role: Role, level: number, side: 'alliance' | 'horde', n: number, tier = 0): Snapshot {
  const h = role === 'dps' ? DPS_HIRELINGS[n % DPS_HIRELINGS.length] : HIRELING[role];
  const race = data.raceClasses?.[h.race[side]]?.includes(h.cls) ? h.race[side] : (Object.entries(data.raceClasses ?? {}).find(([, cl]) => cl.includes(h.cls))?.[0] ?? 1);
  const s = newGame(data, { name: h.name, race: Number(race), cls: h.cls, seed: 1000 + n, now: 0 });
  s.char.level = level;
  s.spells = (data.classSpells?.[h.cls] ?? []).filter(o => o.level <= level).map(o => o.spell);
  s.combatSkills = { 95: level * 5, 162: level * 5 };
  for (const [slot, id] of Object.entries(hirelingGear(data, h.cls, role, level, tier))) s.equipment[slot as Slot] = id;
  for (const id of Object.values(s.equipment)) {
    const prof = id ? proficiencyFor(data.items[id]) : null;
    if (prof) s.combatSkills[prof] = level * 5;
  }
  // Hunters shoot (a stack of their level's best ammo) with a beast at their side; warlocks bring a demon.
  if (h.cls === HUNTER) {
    const w = s.equipment.ranged ? data.items[s.equipment.ranged] : undefined;
    const kind = w?.subclass === 3 ? 3 : 2;
    const ammo = Object.values(data.items).filter(it => it.class === 6 && it.subclass === kind && it.reqLevel <= level).sort((a, b) => b.dmgMax - a.dmgMax)[0];
    if (ammo) s.inventory[ammo.id] = 2000;
    if (level >= TAME_LEVEL) s.pet = { kind: 'beast', name: 'Wolf', displayId: 0 };
  }
  s.char.hp = playerStats(s, data).maxHp;
  const snap = snapshotOf(s, data, null, role, level);
  // Hirelings are weaker than a geared player, except raid hirelings: seasoned raiders in specced builds.
  const power = tier > 0 ? 1.25 : HIRELING_POWER;
  snap.dps = Math.round(snap.dps * power);
  if (role === 'tank') snap.maxHp = Math.round(snap.maxHp * 1.15); // the defensive talents a hired tank would have
  for (const h of snap.heals) h.amount = Math.round(h.amount * power);
  // Hired help brings a few potions of their level: mana for healers, healing for everyone else.
  const best = (key: 'heal' | 'mana') => Object.values(data.items).filter(it => it.potion?.[key] && !(key === 'mana' && it.potion.heal) && it.reqLevel <= level)
    .sort((x, y) => y.potion![key] - x.potion![key])[0];
  const pot = role === 'healer' ? best('mana') : best('heal');
  if (pot) snap.potions = [{ item: pot.id, ...(role === 'healer' ? { mana: pot.potion!.mana } : { heal: pot.potion!.heal }), amount: role === 'healer' ? pot.potion!.mana : pot.potion!.heal, count: 3 }];
  // Hired raid tanks are professionals: they carry the strongest protection potion of each school.
  if (role === 'tank' && tier > 0) {
    const bySchool = new Map<number, ItemDef>();
    for (const it of Object.values(data.items)) if (it.protection && it.reqLevel <= level && (bySchool.get(it.protection.school)?.protection!.amount ?? 0) < it.protection.amount) bySchool.set(it.protection.school, it);
    for (const it of bySchool.values()) (snap.potions ??= []).push({ item: it.id, school: it.protection!.school, amount: it.protection!.amount, count: 2 });
  }
  snap.name = `${h.name} ${n + 1}`;
  snap.hireling = true;
  return snap;
}

const gearCache = new Map<string, Partial<Record<Slot, number>>>();

const raidLootCache = new Map<string, Set<number>>();
/**
 * Items that drop from raid bosses of tiers below `tier` (following loot references): the gear a guild
 * that has cleared those raids would wear.
 */
export function raidLoot(data: GameData, tier: number): Set<number> {
  const key = `${data.builtAt}:${tier}`;
  const hit = raidLootCache.get(key);
  if (hit) return hit;
  const out = new Set<number>();
  for (const d of Object.values(data.dungeons ?? {})) {
    if (!d.raid || (d.tier ?? 9) >= tier) continue;
    for (const [, items] of dungeonLoot(data, d)) for (const i of items) out.add(i);
  }
  raidLootCache.set(key, out);
  return out;
}

const dungeonLootCache = new Map<string, Map<number, number[]>>();
/**
 * What each boss of a dungeon can drop (following loot references), best first: the list members pick
 * their targets from.
 */
export function dungeonLoot(data: GameData, d: DungeonDef): Map<number, number[]> {
  const key = `${data.builtAt}:${d.id}`;
  const hit = dungeonLootCache.get(key);
  if (hit) return hit;
  const out = new Map<number, number[]>();
  for (const e of d.encounters) {
    if (!e.boss || out.has(e.boss)) continue;
    const items = new Set<number>();
    const walk = (ref: string | null | undefined, depth = 0) => {
      const t = ref ? data.loot[ref] : undefined;
      if (!t || depth > 4) return;
      for (const x of [...t.entries, ...t.groups.flat()]) { if ('item' in x) items.add(x.item); else walk(x.ref, depth + 1); }
    };
    walk(data.creatures[e.boss]?.loot);
    const minQ = d.raid ? 3 : 2; // raids: rares and epics (their tables also reference world-drop greens)
    out.set(e.boss, [...items].filter(i => data.items[i] && data.items[i].quality >= minQ)
      .sort((a, b) => data.items[b]!.quality - data.items[a]!.quality || (data.items[b]!.itemLevel ?? 0) - (data.items[a]!.itemLevel ?? 0)));
  }
  dungeonLootCache.set(key, out);
  return out;
}

/** When a raid's lockouts next reset: every `resetDays` days at 09:00 UTC, counted from the epoch. */
export function nextReset(d: DungeonDef, now: number): number {
  const period = (d.resetDays ?? 3) * 86_400_000, offset = 9 * 3_600_000;
  return Math.floor((now - offset) / period) * period + period + offset;
}
/**
 * What a well-geared character of this class and level would wear: per slot, the best green item (and blue
 * from level 50, as endgame groups wear)
 * (by item level) the class can use at that level, preferring the role's stats.
 */
export function hirelingGear(data: GameData, cls: number, role: Role, level: number, tier = 0): Partial<Record<Slot, number>> {
  const key = `${cls}:${role}:${level}:${tier}`;
  const epics = tier > 1 ? raidLoot(data, tier) : null;
  const hit = gearCache.get(key);
  if (hit) return hit;
  const skills = data.classSkills?.[cls] ?? {};
  const wanted: Record<Role, number[]> = { tank: [7, 4, 3], healer: [5, 6, 7], dps: cls === 8 || cls === 5 || cls === 9 ? [5, 6, 7] : [4, 3, 7] }; // stat ids
  const best = new Map<Slot, { id: number; score: number }>();
  for (const it of Object.values(data.items)) {
    if (it.quality < 2 || (it.quality > (level >= 50 ? 3 : 2) && !epics?.has(it.id)) || it.reqLevel > level || it.reqLevel < level - 12 || !equipSlots(it).length) continue;
    const prof = proficiencyFor(it);
    if (prof && (skills[prof] === undefined || skills[prof] > level)) continue;
    if (it.class === 2 && it.subclass === 20) continue; // fishing poles
    const shield = it.invType === 14;
    if (shield && role !== 'tank') continue;
    if (it.invType === 17 && role === 'tank') continue; // tanks use a one-hander and a shield
    const stats = it.stats.reduce((a, [t, v]) => a + (wanted[role].includes(t) ? v * 2 : v), 0);
    const score = (it.itemLevel ?? it.reqLevel) * 10 + stats + it.armor / 20 + (it.dmgMax ? (it.dmgMin + it.dmgMax) / 2 / (it.delayMs / 1000) : 0);
    for (const slot of equipSlots(it)) {
      if (slot === 'finger2' || slot === 'trinket2') continue;
      const cur = best.get(slot);
      if (!cur || score > cur.score) best.set(slot, { id: it.id, score });
    }
  }
  const out: Partial<Record<Slot, number>> = {};
  for (const [slot, { id }] of best) out[slot] = id;
  if (out.mainhand && data.items[out.mainhand]?.invType === 17) delete out.offhand;
  gearCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- the run

/** Replay events. Members are indexed 0..n-1; mobs by their uid within the run. */
export type RunEvent =
  | { t: number; k: 'pull'; enc: number; mobs: { uid: number; id: number; level: number; hp: number }[] }
  | { t: number; k: 'hit'; src: number; dst: number; mob: boolean; amt: number; crit?: boolean; spell?: number }
  | { t: number; k: 'heal'; src: number; dst: number; amt: number }
  | { t: number; k: 'cast'; mob: number; spell: number; dst: number | 'all' }
  | { t: number; k: 'die'; who: number; mob: boolean }
  | { t: number; k: 'clear'; enc: number }
  | { t: number; k: 'wipe'; enc: number }
  | { t: number; k: 'rest'; ms: number };

export interface RunLoot { item: number; count: number; winner: number | null; boss: number | null; rolls: { member: number; roll: number; need: boolean }[]; targeted?: boolean }

export interface RunResult {
  dungeon: number; seed: number;
  cleared: boolean;
  /** Encounters finished (index of the last one cleared + 1). */
  progress: number;
  durationMs: number;
  /** Creature ids killed, in order (for quest credit and the log). */
  kills: number[];
  xp: number[]; gold: number;
  loot: RunLoot[];
  /** Potions drunk: [member, item, count]. */
  used: [number, number, number][];
  events: RunEvent[];
}

interface Mob { uid: number; def: CreatureDef; level: number; hp: number; maxHp: number; nextSwing: number; enrage: number; enrageUntil: number;
  timers: number[]; stunnedUntil: number; dots: { dst: number; per: number; left: number; school: number }[] }
interface Member { snap: Snapshot; hp: number; mana: number; dead: boolean; ccUntil: number; castEnd: number; castDst: number; castAmount: number; pushes: number;
  dots: { per: number; left: number; school: number }[];
  /** Damage still absorbed per school (protection potions), potions left, and the potion cooldown. */
  absorb: number[]; potions: NonNullable<Snapshot['potions']>; potionReadyAt: number }

const PULL_LIMIT_S = 600;     // a pull that lasts 10 minutes is a wipe (the group can't kill it)
const WALK_S = 20;            // between pulls
const REST_S = 15;            // eat and drink after a pull
const CORPSE_RUN_S = 90;      // after a wipe
const RETRIES = 2;
const ENRAGE_MS = 8000;       // frenzies and enrages are bursts (removed or run out), not permanent stacks
const enraged = (mob: { enrage: number; enrageUntil: number }, t: number) => (t < mob.enrageUntil ? mob.enrage : 0);
/** Who can crowd-control what (creature types): Polymorph, Sap, Fear, Freezing Trap, Shackle Undead, Hibernate. */
const CC_TYPES: Record<number, number[] | 'any'> = { 8: [1, 7, 8], 4: [7], 9: 'any', 3: 'any', 5: [6], 11: [1, 2] };
/** Who stands next to the boss: tanks, and damage dealers of melee classes (warrior, paladin, rogue). */
const MELEE_CLASSES = new Set([1, 2, 4]);
const inMelee = (s: Snapshot) => s.role === 'tank' || (s.role === 'dps' && MELEE_CLASSES.has(s.cls));        // mobs fighting at once; groups crowd-control the rest of a pack

/**
 * Raid buffs: a group of ten or more brings the classes' buffs (Blessings, Mark of the Wild, Fortitude,
 * Battle Shout, Arcane Intellect): more damage, health, armor and resistances for everyone.
 */
export function withRaidBuffs(snaps: Snapshot[]): Snapshot[] {
  if (snaps.length < 10) return snaps;
  return snaps.map(s => ({
    ...s, dps: Math.round(s.dps * 1.2), maxHp: Math.round(s.maxHp * 1.12), armor: s.armor + 285,
    resist: s.resist.map((v, i) => (i ? v + 20 : v)), maxMana: Math.round(s.maxMana * 1.1),
    heals: s.heals.map(h => ({ ...h, amount: Math.round(h.amount * 1.1) })),
  }));
}

export function simulateRun(data: GameData, dungeon: DungeonDef, rawSnaps: Snapshot[], seed: number): RunResult {
  const rng = seedRng(seed);
  const snaps = withRaidBuffs(rawSnaps);
  const events: RunEvent[] = [];
  const members: Member[] = snaps.map(snap => ({ snap, hp: snap.maxHp, mana: snap.maxMana, dead: false, ccUntil: 0, castEnd: 0, castDst: -1, castAmount: 0, pushes: 0, dots: [],
    absorb: [0, 0, 0, 0, 0, 0, 0], potions: (snap.potions ?? []).map(p => ({ ...p })), potionReadyAt: 0 }));
  const used = new Map<string, number>();
  const use = (member: number, item: number) => used.set(`${member}:${item}`, (used.get(`${member}:${item}`) ?? 0) + 1);
  const kills: number[] = [];
  let t = 0, uid = 0, gold = 0, progress = 0;
  const loot: RunLoot[] = [];
  const xp = snaps.map(() => 0);
  const groupBonus = snaps.length >= 5 ? 1.4 : snaps.length === 4 ? 1.3 : snaps.length === 3 ? 1.166 : 1;

  for (let enc = 0; enc < dungeon.encounters.length; enc++) {
    const e = dungeon.encounters[enc];
    let cleared = false;
    for (let attempt = 0; attempt <= RETRIES && !cleared; attempt++) {
      // Walk up, everyone rested and alive.
      t += WALK_S * 1000;
      for (const m of members) { m.dead = false; m.hp = m.snap.maxHp; m.mana = m.snap.maxMana; m.dots = []; m.ccUntil = 0; m.castEnd = 0; m.absorb = [0, 0, 0, 0, 0, 0, 0]; m.potionReadyAt = 0; }
      // Before a boss: a protection potion for each school its abilities deal.
      if (e.boss) {
        const schools = new Set((data.creatures[e.boss]?.abilities ?? []).flatMap(a => a.effects.flatMap(x => (x.k === 'damage' || x.k === 'dot') && x.school > 0 ? [x.school] : [])));
        members.forEach((m, i) => {
          for (const p of m.potions) if (p.school && schools.has(p.school) && p.count > 0) { p.count--; m.absorb[p.school] += p.amount; use(i, p.item); }
        });
      }
      const mobs: Mob[] = [];
      for (const [id, count] of e.mobs) {
        const def = data.creatures[id];
        if (!def) continue;
        for (let i = 0; i < count; i++) mobs.push(spawnMob(def, ++uid, rng, t));
      }
      if (!mobs.length) { cleared = true; break; }
      events.push({ t, k: 'pull', enc, mobs: mobs.map(m => ({ uid: m.uid, id: m.def.id, level: m.level, hp: m.maxHp })) });
      cleared = fight(data, members, mobs, rng, t, events, (dt) => { t = dt; }, use, e.boss);
      for (const m of mobs) if (m.hp <= 0) {
        kills.push(m.def.id);
        gold += m.def.goldMax ? int(rng, m.def.goldMin, m.def.goldMax) : 0;
        snaps.forEach((sn, i) => { xp[i] += Math.round(killXp(sn.level, m.level, m.def.rank) * groupBonus / snaps.length); });
      }
      if (cleared) {
        events.push({ t, k: 'clear', enc });
        progress = enc + 1;
        if (e.boss) loot.push(...bossLoot(data, e.boss, snaps, rng, loot));
        events.push({ t, k: 'rest', ms: REST_S * 1000 });
        t += REST_S * 1000;
      } else {
        events.push({ t, k: 'wipe', enc });
        t += CORPSE_RUN_S * 1000;
      }
    }
    if (!cleared) break;
  }
  return {
    dungeon: dungeon.id, seed, cleared: progress === dungeon.encounters.length, progress, durationMs: t, kills, xp, gold, loot,
    used: [...used].map(([k, n]) => { const [m, item] = k.split(':').map(Number); return [m, item, n] as [number, number, number]; }),
    events,
  };
}

function spawnMob(def: CreatureDef, uid: number, rng: RngState, t: number): Mob {
  const level = int(rng, def.levelMin, def.levelMax);
  const st = def.stats[level - def.levelMin] ?? def.stats[0];
  return {
    uid, def, level, hp: st.hp, maxHp: st.hp, nextSwing: t + int(rng, 200, def.attackMs), enrage: 0, enrageUntil: 0, stunnedUntil: 0, dots: [],
    timers: (def.abilities ?? []).map(a => t + int(rng, a.firstMs[0], Math.max(a.firstMs[0], a.firstMs[1])) + 1000),
  };
}

/** Resisted share of a spell school's damage (vanilla's average resistance). */
const resisted = (m: Member, school: number, level: number) =>
  school > 0 ? Math.min(0.75, ((m.snap.resist[school] ?? 0) / Math.max(1, level * 5)) * 0.75) : 0;

function fight(data: GameData, members: Member[], mobs: Mob[], rng: RngState, start: number, events: RunEvent[], setT: (t: number) => void,
  use: (member: number, item: number) => void, boss?: number): boolean {
  const alive = () => members.filter(m => !m.dead);
  // Tanks: the first holds the boss (and the first mob); the others pick up the rest of the pack.
  const tanks = members.map((m, i) => (m.snap.role === 'tank' ? i : -1)).filter(i => i >= 0);
  const healerRank = new Map(members.map((m, i) => (m.snap.role === 'healer' ? i : -1)).filter(i => i >= 0).map((i, k) => [i, k]));
  let tauntLostUntil = 0;
  let t = start;
  for (let sec = 0; sec < PULL_LIMIT_S; sec++) {
    t += 1000;
    const living = mobs.filter(m => m.hp > 0);
    if (!living.length) { setT(t); return true; }
    if (!alive().length) { setT(t); return false; }
    // Kill order: casters that crowd-control or heal first (as groups do), then the weakest.
    const danger = (m: Mob) => (m.def.abilities ?? []).some(a => a.effects.some(e => e.k === 'cc' || e.k === 'heal')) ? 0 : 1;
    const pickFocus = () => mobs.filter(m => m.hp > 0).sort((a, b) => danger(a) - danger(b) || a.hp - b.hp)[0];

    // ---- members act
    members.forEach((m, i) => {
      if (m.dead || m.ccUntil > t) return;
      // A mana potion when a caster runs low (shares the potion cooldown).
      if (m.snap.maxMana && m.mana < m.snap.maxMana * 0.25 && m.potionReadyAt <= t) {
        const p = m.potions.find(x => x.mana && x.count > 0);
        if (p) { p.count--; m.potionReadyAt = t + 120_000; use(i, p.item); m.mana = Math.min(m.snap.maxMana, m.mana + p.amount); }
      }
      // A healing potion when it gets dangerous (2 minute cooldown).
      if (m.hp < m.snap.maxHp * 0.35 && m.potionReadyAt <= t) {
        const p = m.potions.find(x => x.heal && x.count > 0);
        if (p) {
          p.count--; m.potionReadyAt = t + 120_000; use(i, p.item);
          const amt = Math.min(p.amount, m.snap.maxHp - m.hp);
          m.hp += amt;
          events.push({ t, k: 'heal', src: i, dst: i, amt });
        }
      }
      if (m.snap.role === 'healer' && m.snap.heals.length) {
        if (m.castEnd && m.castEnd <= t) {
          const target = members[m.castDst];
          if (target && !target.dead) {
            const amt = Math.min(m.castAmount, target.snap.maxHp - target.hp);
            target.hp += amt;
            if (amt > 0) events.push({ t, k: 'heal', src: i, dst: m.castDst, amt });
          }
          m.castEnd = 0;
        }
        m.mana = Math.min(m.snap.maxMana, m.mana + m.snap.manaPerSec * 0.3); // casting: little regen (five-second rule)
        if (!m.castEnd) {
          // Tank healers (about half) keep heals going on the tank that's taking damage, overheal and all.
          // Raid healers count heals already on their way, so they spread out instead of overhealing.
          const incoming = (j: number) => members.reduce((a, h) => a + (h.castEnd && h.castDst === j ? h.castAmount : 0), 0);
          const tankTaking = tanks.filter(j => !members[j].dead).sort((a, b) => members[a].hp / members[a].snap.maxHp - members[b].hp / members[b].snap.maxHp)[0];
          const onTank = healerRank.get(i)! < Math.ceil(healerRank.size / 2) && tankTaking !== undefined && members[tankTaking].hp < members[tankTaking].snap.maxHp * 0.95;
          const hurt = onTank ? { x: members[tankTaking!], j: tankTaking!, missing: members[tankTaking!].snap.maxHp - members[tankTaking!].hp }
            : members.map((x, j) => ({ x, j, missing: x.snap.maxHp - x.hp - incoming(j) }))
              .filter(({ x, missing }) => !x.dead && missing > x.snap.maxHp * 0.15)
              .sort((a, b) => (a.x.hp + incoming(a.j)) / a.x.snap.maxHp - (b.x.hp + incoming(b.j)) / b.x.snap.maxHp)[0];
          if (hurt) {
            // The cheapest rank that covers what's missing, else the biggest affordable one.
            const missing = hurt.missing;
            const affordable = m.snap.heals.filter(h => h.cost <= m.mana);
            const pick = affordable.find(h => h.amount >= missing * 0.9) ?? affordable.sort((a, b) => b.amount - a.amount)[0];
            if (pick) { m.mana -= pick.cost; m.castEnd = t + pick.castMs; m.castDst = hurt.j; m.castAmount = pick.amount; m.pushes = 0; return; }
          }
        }
        if (m.castEnd) return;
      }
      const dps = m.snap.role === 'tank' ? m.snap.dps * 0.7 : m.snap.role === 'healer' ? m.snap.dps * 0.3 : m.snap.dps;
      if (dps <= 0) return;
      const focus = pickFocus(); // the next living target (no damage wasted on a mob that just died)
      if (!focus) return;
      const crit = chance(rng, 10);
      const amt = Math.max(1, Math.round(dps * (0.85 + next(rng) * 0.3) * (crit ? 1.5 : 1)));
      focus.hp -= amt;
      events.push({ t, k: 'hit', src: i, dst: focus.uid, mob: false, amt, ...(crit ? { crit } : {}) });
      if (focus.hp <= 0) events.push({ t, k: 'die', who: focus.uid, mob: true });
    });

    // ---- mobs act
    // Crowd control: each member who can hold a mob (Polymorph, Sap, Fear, Freezing Trap, Shackle Undead,
    // Hibernate) holds one the first mob isn't; bosses are never controlled. The rest fight.
    const active = new Set(living);
    const ccers = members.filter(m => !m.dead && m.ccUntil <= t && CC_TYPES[m.snap.cls]);
    for (const mob of living.slice(1).reverse()) {
      if (mob.def.id === boss || mob.def.rank === 3) continue;
      const k = ccers.findIndex(m => { const ok = CC_TYPES[m.snap.cls]!; return ok === 'any' || ok.includes(mob.def.type); });
      if (k < 0) continue;
      ccers.splice(k, 1);
      active.delete(mob);
    }
    for (const mob of mobs) {
      if (mob.hp <= 0 || !active.has(mob)) continue;
      const target = (): number => {
        if (tauntLostUntil <= t && tanks.length) {
          const mine = tanks[mobs.indexOf(mob) % tanks.length];
          const ready = (i: number) => !members[i].dead && members[i].ccUntil <= t;
          const pick = ready(mine) ? mine : tanks.find(ready);
          if (pick !== undefined) return pick;
        }
        // Untanked mobs go for whoever draws the most threat: the healer, then anyone.
        const healer = members.findIndex(m => m.snap.role === 'healer' && !m.dead);
        if (healer >= 0 && chance(rng, 70)) return healer;
        const a = alive();
        return a.length ? members.indexOf(a[int(rng, 0, a.length - 1)]) : -1;
      };
      if (mob.stunnedUntil > t) continue;
      // Abilities
      (mob.def.abilities ?? []).forEach((ab, ai) => {
        if (mob.timers[ai] > t) return;
        mob.timers[ai] = t + int(rng, ab.repeatMs[0], Math.max(ab.repeatMs[0], ab.repeatMs[1]));
        if (!chance(rng, ab.chance)) return;
        const dst = ab.target === 'self' ? -1 : ab.target === 'tank' ? target() : (() => { const a = alive(); return a.length ? members.indexOf(a[int(rng, 0, a.length - 1)]) : -1; })();
        events.push({ t, k: 'cast', mob: mob.uid, spell: ab.spell, dst: ab.aoe ? 'all' : dst });
        for (const eff of ab.effects) applyAbility(eff, ab, mob, dst, members, mobs, data, rng, t, events, () => { tauntLostUntil = t + 1500; });
      });
      // Melee
      while (mob.nextSwing <= t) {
        mob.nextSwing += mob.def.attackMs;
        const dst = target();
        if (dst < 0) break;
        swing(mob, dst, members, rng, t, events);
      }
    }
    // ---- damage over time on members
    members.forEach((m, i) => {
      if (m.dead) return;
      for (const d of m.dots) {
        if (d.left <= 0) continue;
        d.left--;
        hurt(m, i, Math.round(d.per * (1 - resisted(m, d.school, 60))), -1, events, t, undefined, d.school);
      }
      m.dots = m.dots.filter(d => d.left > 0);
    });
  }
  setT(t);
  return false;
}

/** Tanks fight in Defensive Stance, Bear Form or with Righteous Fury: 10% less damage taken. */
const TANK_STANCE = 0.9;

function hurt(m: Member, i: number, amt: number, src: number, events: RunEvent[], t: number, spell?: number, school = 0): void {
  if (m.dead || amt <= 0) return;
  if (school > 0 && m.absorb[school] > 0) {
    const soaked = Math.min(m.absorb[school], amt);
    m.absorb[school] -= soaked;
    amt -= soaked;
    if (amt <= 0) return;
  }
  if (m.snap.role === 'tank') amt = Math.max(1, Math.round(amt * TANK_STANCE));
  m.hp -= amt;
  if (m.castEnd && m.pushes < 2) { m.castEnd += 500; m.pushes++; } // spell pushback, at most twice per cast
  events.push({ t, k: 'hit', src, dst: i, mob: true, amt, ...(spell ? { spell } : {}) });
  if (m.hp <= 0) { m.hp = 0; m.dead = true; m.castEnd = 0; events.push({ t, k: 'die', who: i, mob: false }); }
}

function swing(mob: Mob, dst: number, members: Member[], rng: RngState, t: number, events: RunEvent[]): void {
  const m = members[dst];
  const st = mob.def.stats[mob.level - mob.def.levelMin] ?? mob.def.stats[0];
  const defBonus = Math.max(0, (m.snap.defense - mob.level * 5) * 0.04);
  const miss = missChance(mob.level * 5, m.snap.defense);
  const dodge = m.snap.dodge + defBonus;
  // Tanks also parry (5% plus Defense, plus talents), and with a shield they block some of each hit.
  const tank = m.snap.role === 'tank';
  const parry = tank ? 10 + defBonus : 0;
  const block = tank && m.snap.block ? 15 + defBonus : 0;
  const roll = next(rng) * 100;
  if (roll < miss + dodge + parry) return;
  const crit = roll >= 100 - 5;
  const base = int(rng, st.dmgMin, st.dmgMax) * (1 + enraged(mob, t) / 100) * (crit ? 2 : 1);
  let dmg = base * (1 - armorReduction(m.snap.armor, mob.level));
  if (!crit && roll < miss + dodge + parry + block) dmg -= m.snap.block ?? 0;
  hurt(m, dst, Math.max(1, Math.round(dmg)), mob.uid, events, t);
}

function applyAbility(eff: AbilityEffect, ab: CreatureAbility, mob: Mob, dst: number, members: Member[], mobs: Mob[], data: GameData,
  rng: RngState, t: number, events: RunEvent[], dropAggro: () => void): void {
  const targets = ab.aoe ? members.map((_, i) => i).filter(i => !members[i].dead && (!ab.melee || inMelee(members[i].snap))) : dst >= 0 ? [dst] : [];
  switch (eff.k) {
    case 'damage':
      for (const i of targets) {
        const m = members[i];
        const raw = int(rng, eff.min, Math.max(eff.min, eff.max)) * (1 + enraged(mob, t) / 100);
        const mitigated = eff.school === 0 ? raw * (1 - armorReduction(m.snap.armor, mob.level)) : raw * (1 - resisted(m, eff.school, mob.level));
        hurt(m, i, Math.round(mitigated), mob.uid, events, t, ab.spell, eff.school);
      }
      break;
    case 'dot':
      for (const i of targets) members[i].dots.push({ per: eff.perTick * (1000 / Math.max(1000, eff.ampMs)), left: Math.round(eff.ticks * eff.ampMs / 1000), school: eff.school });
      break;
    case 'cc':
      for (const i of targets) { members[i].ccUntil = t + eff.ms; members[i].castEnd = 0; }
      break;
    case 'heal': mob.hp = Math.min(mob.maxHp, mob.hp + eff.amount); break;
    case 'enrage': mob.enrage = Math.min(150, eff.pct); mob.enrageUntil = t + ENRAGE_MS; break;
    case 'extraAttacks': for (let k = 0; k < eff.n && dst >= 0; k++) swing(mob, dst, members, rng, t, events); break;
    case 'knockback': dropAggro(); break;
    case 'summon': {
      const def = data.creatures[eff.creature];
      if (!def || mobs.length > 12) break;
      for (let k = 0; k < Math.min(3, eff.count); k++) mobs.push(spawnMob(def, 100000 + mobs.length, rng, t));
      break;
    }
  }
}

// ---------------------------------------------------------------- loot: need before greed

/** Whether a member can use an item (weapon/armor skill and level), which earns a Need roll. */
export function canUse(data: GameData, snap: Snapshot, it: ItemDef): boolean {
  if (!equipSlots(it).length || it.reqLevel > snap.level) return false;
  const prof = proficiencyFor(it);
  if (!prof) return true;
  const min = data.classSkills?.[snap.cls]?.[prof];
  return min !== undefined && min <= snap.level;
}

/**
 * Loot: an item someone targeted goes to them (a roll among everyone who targeted it, each target
 * filled once per run); anything else is need before greed. Hirelings never roll.
 */
function bossLoot(data: GameData, boss: number, snaps: Snapshot[], rng: RngState, already: RunLoot[]): RunLoot[] {
  const def = data.creatures[boss];
  if (!def?.loot) return [];
  const out: RunLoot[] = [];
  const has = (member: number, item: number) => [...already, ...out].some(l => l.winner === member && l.item === item);
  for (const [item, count] of rollLoot(data, def.loot, rng)) {
    const it = data.items[item];
    if (!it) continue;
    const rolls = snaps.map((sn, member) => ({ member, roll: int(rng, 1, 100), need: !sn.hireling && canUse(data, sn, it) }))
      .filter(r => !snaps[r.member].hireling);
    const targeted = rolls.filter(r => snaps[r.member].targets?.includes(item) && !has(r.member, item));
    const needers = rolls.filter(r => r.need);
    const pool = targeted.length ? targeted : needers.length ? needers : rolls;
    const best = pool.reduce<typeof pool[number] | null>((a, r) => (!a || r.roll > a.roll ? r : a), null);
    out.push({ item, count, boss, winner: best ? best.member : null, rolls, ...(targeted.length ? { targeted: true } : {}) });
  }
  return out;
}

/** The side a group fights for (hirelings match the leader). */
export const sideOfRace = (data: GameData, race: number) => factionOfRace(data, race);

// ---------------------------------------------------------------- rewards

export interface RunReward { xp: number; gold: number; items: [number, number][]; questItems: [number, number][] }

/**
 * What one member takes home from a run: their share of experience and gold, the loot they won, kill
 * credit for their quests, and the quest items those kills drop for them (rolled with their own seed,
 * only while their quests still need them).
 */
export function applyRunRewards(s: GameState, data: GameData, r: RunResult, member: number, players: number): RunReward {
  const xp = r.xp[member] ?? 0;
  const gold = Math.floor(r.gold / Math.max(1, players));
  const items: [number, number][] = r.loot.filter(l => l.winner === member).map(l => [l.item, l.count]);
  s.gold += gold;
  for (const [i, n] of items) addItem(s, i, n);
  for (const [m, item, n] of r.used ?? []) if (m === member) addItem(s, item, -Math.min(n, s.inventory[item] ?? 0));
  const questItems = new Map<number, number>();
  const rng = seedRng((r.seed * 31 + member + 1) >>> 0);
  for (const id of r.kills) {
    creditKill(s, data, id);
    const def = data.creatures[id];
    const needed = neededQuestItems(s, data);
    if (!def?.loot || !needed.size) continue;
    for (const [item, n] of rollLoot(data, def.loot, rng, needed)) {
      if (!needed.has(item)) continue;
      addItem(s, item, n);
      questItems.set(item, (questItems.get(item) ?? 0) + n);
    }
  }
  grantXp(s, data, xp);
  const name = data.dungeons?.[r.dungeon]?.name ?? 'the dungeon';
  log(s, 'loot', `${name}: ${r.cleared ? 'cleared' : `${r.progress} of ${data.dungeons?.[r.dungeon]?.encounters.length ?? '?'} pulls`}, ${xp} XP${items.length ? `, ${items.map(([i]) => data.items[i]?.name ?? i).join(', ')}` : ''}.`);
  return { xp, gold, items, questItems: [...questItems] };
}

/** How many tanks and healers a group of this size runs with (the rest deal damage). */
export function groupRoles(size: number): { tanks: number; healers: number } {
  return size >= 40 ? { tanks: 4, healers: 10 } : size >= 20 ? { tanks: 2, healers: 5 } : size >= 10 ? { tanks: 2, healers: 2 } : { tanks: 1, healers: 1 };
}
