// The group simulation: a dungeon run resolved from member snapshots by a seeded, deterministic sim.
//
// Each member is a snapshot (taken when the run starts): role, health, armor and avoidance, resistances,
// damage per second measured by fighting a training dummy with their real spells, talents and gear,
// and their best heal. Pulls run in 1-second steps: the tank holds the mobs, the healer heals, damage
// dealers kill; creature abilities (from their spell lists) hit tanks, random members or everyone, and
// are reduced by resistances. Members rest between pulls; a wiped pull is retried twice before the
// run fails. The event log is the replay.
import type { CreatureDef, GameData, ItemDef } from './data.js';
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
  /** Resistances by school index (1 holy .. 6 arcane). */
  resist: number[];
  dps: number;
  /** Spammable heals, cheapest first (healers down-rank to fit the damage). */
  heals: Heal[];
  maxMana: number; manaPerSec: number;
  /** Item ids the member could use (for need rolls), decided at snapshot time. */
  hireling?: boolean;
}

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
    if (e.type === 'swing' && e.who === 'player') dmg += e.dmg;
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

export function snapshotOf(s: GameState, data: GameData, accountId: number | null, role: Role, targetLevel: number): Snapshot {
  const st = playerStats(s, data);
  const resist = [0, 0, 0, 0, 0, 0, 0];
  const gear: Snapshot['gear'] = [];
  for (const slot of SLOTS) {
    const it = s.equipment[slot] ? data.items[s.equipment[slot]!] : undefined;
    if (!it) continue;
    it.resist?.forEach((v, i) => { resist[i] += v; });
    if (it.displayId) gear.push({ displayId: it.displayId, invType: it.invType, slot });
  }
  return {
    accountId, name: s.char.name, race: s.char.race, cls: s.char.cls, level: s.char.level, role,
    ...(s.char.look ? { look: s.char.look } : {}), gear,
    maxHp: st.maxHp, armor: st.armor, dodge: st.dodge, defense: s.combatSkills[SKILL_DEFENSE] ?? s.char.level * 5,
    resist, dps: measureDps(s, data, targetLevel),
    heals: role === 'healer' ? healsOf(s, data) : [],
    maxMana: st.maxMana, manaPerSec: Math.max(1, st.maxMana / 120),
  };
}

// Hirelings: a level-appropriate member of the role, trained in every spell, in modest gear.
const HIRELING: Record<Role, { cls: number; name: string; race: Record<'alliance' | 'horde', number> }> = {
  tank: { cls: 1, name: 'Hired Shieldbearer', race: { alliance: 3, horde: 2 } },
  healer: { cls: 5, name: 'Hired Priest', race: { alliance: 1, horde: 5 } },
  dps: { cls: 8, name: 'Hired Battlemage', race: { alliance: 7, horde: 8 } },
};
/** Hirelings are paid help: weaker than a geared player, but enough that two friends can run a dungeon. */
export const HIRELING_POWER = 0.8;

export function hireling(data: GameData, role: Role, level: number, side: 'alliance' | 'horde', n: number): Snapshot {
  const h = HIRELING[role];
  const race = data.raceClasses?.[h.race[side]]?.includes(h.cls) ? h.race[side] : (Object.entries(data.raceClasses ?? {}).find(([, cl]) => cl.includes(h.cls))?.[0] ?? 1);
  const s = newGame(data, { name: h.name, race: Number(race), cls: h.cls, seed: 1000 + n, now: 0 });
  s.char.level = level;
  s.spells = (data.classSpells?.[h.cls] ?? []).filter(o => o.level <= level).map(o => o.spell);
  s.combatSkills = { 95: level * 5, 162: level * 5 };
  for (const [slot, id] of Object.entries(hirelingGear(data, h.cls, role, level))) s.equipment[slot as Slot] = id;
  for (const id of Object.values(s.equipment)) {
    const prof = id ? proficiencyFor(data.items[id]) : null;
    if (prof) s.combatSkills[prof] = level * 5;
  }
  s.char.hp = playerStats(s, data).maxHp;
  const snap = snapshotOf(s, data, null, role, level);
  snap.dps = Math.round(snap.dps * HIRELING_POWER);
  for (const h of snap.heals) h.amount = Math.round(h.amount * HIRELING_POWER);
  snap.name = `${h.name} ${n + 1}`;
  snap.hireling = true;
  return snap;
}

const gearCache = new Map<string, Partial<Record<Slot, number>>>();
/**
 * What a well-geared character of this class and level would wear: per slot, the best green or blue item
 * (by item level) the class can use at that level, preferring the role's stats.
 */
export function hirelingGear(data: GameData, cls: number, role: Role, level: number): Partial<Record<Slot, number>> {
  const key = `${cls}:${role}:${level}`;
  const hit = gearCache.get(key);
  if (hit) return hit;
  const skills = data.classSkills?.[cls] ?? {};
  const wanted: Record<Role, number[]> = { tank: [7, 4, 3], healer: [5, 6, 7], dps: cls === 8 || cls === 5 || cls === 9 ? [5, 6, 7] : [4, 3, 7] }; // stat ids
  const best = new Map<Slot, { id: number; score: number }>();
  for (const it of Object.values(data.items)) {
    if (it.quality < 2 || it.quality > 3 || it.reqLevel > level || it.reqLevel < level - 12 || !equipSlots(it).length) continue;
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

export interface RunLoot { item: number; count: number; winner: number | null; boss: number | null; rolls: { member: number; roll: number; need: boolean }[] }

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
  events: RunEvent[];
}

interface Mob { uid: number; def: CreatureDef; level: number; hp: number; maxHp: number; nextSwing: number; enrage: number;
  timers: number[]; stunnedUntil: number; dots: { dst: number; per: number; left: number; school: number }[] }
interface Member { snap: Snapshot; hp: number; mana: number; dead: boolean; ccUntil: number; castEnd: number; castDst: number; castAmount: number;
  dots: { per: number; left: number; school: number }[] }

const PULL_LIMIT_S = 600;     // a pull that lasts 10 minutes is a wipe (the group can't kill it)
const WALK_S = 20;            // between pulls
const REST_S = 15;            // eat and drink after a pull
const CORPSE_RUN_S = 90;      // after a wipe
const RETRIES = 2;
const CC_ACTIVE = 3;        // mobs fighting at once; groups crowd-control the rest of a pack

export function simulateRun(data: GameData, dungeon: DungeonDef, snaps: Snapshot[], seed: number): RunResult {
  const rng = seedRng(seed);
  const events: RunEvent[] = [];
  const members: Member[] = snaps.map(snap => ({ snap, hp: snap.maxHp, mana: snap.maxMana, dead: false, ccUntil: 0, castEnd: 0, castDst: -1, castAmount: 0, dots: [] }));
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
      for (const m of members) { m.dead = false; m.hp = m.snap.maxHp; m.mana = m.snap.maxMana; m.dots = []; m.ccUntil = 0; m.castEnd = 0; }
      const mobs: Mob[] = [];
      for (const [id, count] of e.mobs) {
        const def = data.creatures[id];
        if (!def) continue;
        for (let i = 0; i < count; i++) mobs.push(spawnMob(def, ++uid, rng, t));
      }
      if (!mobs.length) { cleared = true; break; }
      events.push({ t, k: 'pull', enc, mobs: mobs.map(m => ({ uid: m.uid, id: m.def.id, level: m.level, hp: m.maxHp })) });
      cleared = fight(data, members, mobs, rng, t, events, (dt) => { t = dt; });
      for (const m of mobs) if (m.hp <= 0) {
        kills.push(m.def.id);
        gold += m.def.goldMax ? int(rng, m.def.goldMin, m.def.goldMax) : 0;
        snaps.forEach((sn, i) => { xp[i] += Math.round(killXp(sn.level, m.level, m.def.rank) * groupBonus / snaps.length); });
      }
      if (cleared) {
        events.push({ t, k: 'clear', enc });
        progress = enc + 1;
        if (e.boss) loot.push(...bossLoot(data, e.boss, snaps, rng));
        events.push({ t, k: 'rest', ms: REST_S * 1000 });
        t += REST_S * 1000;
      } else {
        events.push({ t, k: 'wipe', enc });
        t += CORPSE_RUN_S * 1000;
      }
    }
    if (!cleared) break;
  }
  return { dungeon: dungeon.id, seed, cleared: progress === dungeon.encounters.length, progress, durationMs: t, kills, xp, gold, loot, events };
}

function spawnMob(def: CreatureDef, uid: number, rng: RngState, t: number): Mob {
  const level = int(rng, def.levelMin, def.levelMax);
  const st = def.stats[level - def.levelMin] ?? def.stats[0];
  return {
    uid, def, level, hp: st.hp, maxHp: st.hp, nextSwing: t + int(rng, 200, def.attackMs), enrage: 0, stunnedUntil: 0, dots: [],
    timers: (def.abilities ?? []).map(a => t + int(rng, a.firstMs[0], Math.max(a.firstMs[0], a.firstMs[1])) + 1000),
  };
}

/** Resisted share of a spell school's damage (vanilla's average resistance). */
const resisted = (m: Member, school: number, level: number) =>
  school > 0 ? Math.min(0.75, ((m.snap.resist[school] ?? 0) / Math.max(1, level * 5)) * 0.75) : 0;

function fight(data: GameData, members: Member[], mobs: Mob[], rng: RngState, start: number, events: RunEvent[], setT: (t: number) => void): boolean {
  const alive = () => members.filter(m => !m.dead);
  const tankIdx = members.findIndex(m => m.snap.role === 'tank');
  let tauntLostUntil = 0;
  let t = start;
  for (let sec = 0; sec < PULL_LIMIT_S; sec++) {
    t += 1000;
    const living = mobs.filter(m => m.hp > 0);
    if (!living.length) { setT(t); return true; }
    if (!alive().length) { setT(t); return false; }
    const focus = living[0];

    // ---- members act
    members.forEach((m, i) => {
      if (m.dead || m.ccUntil > t) return;
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
          const hurt = members.map((x, j) => ({ x, j })).filter(({ x }) => !x.dead && x.hp < x.snap.maxHp * 0.85)
            .sort((a, b) => a.x.hp / a.x.snap.maxHp - b.x.hp / b.x.snap.maxHp)[0];
          if (hurt) {
            // The cheapest rank that covers what's missing, else the biggest affordable one.
            const missing = hurt.x.snap.maxHp - hurt.x.hp;
            const affordable = m.snap.heals.filter(h => h.cost <= m.mana);
            const pick = affordable.find(h => h.amount >= missing * 0.9) ?? affordable.sort((a, b) => b.amount - a.amount)[0];
            if (pick) { m.mana -= pick.cost; m.castEnd = t + pick.castMs; m.castDst = hurt.j; m.castAmount = pick.amount; return; }
          }
        }
        if (m.castEnd) return;
      }
      const dps = m.snap.role === 'tank' ? m.snap.dps * 0.7 : m.snap.role === 'healer' ? m.snap.dps * 0.3 : m.snap.dps;
      if (dps <= 0) return;
      const crit = chance(rng, 10);
      const amt = Math.max(1, Math.round(dps * (0.85 + next(rng) * 0.3) * (crit ? 1.5 : 1)));
      focus.hp -= amt;
      events.push({ t, k: 'hit', src: i, dst: focus.uid, mob: false, amt, ...(crit ? { crit } : {}) });
      if (focus.hp <= 0) events.push({ t, k: 'die', who: focus.uid, mob: true });
    });

    // ---- mobs act
    // Crowd control: only the first CC_ACTIVE living mobs fight; the rest wait (sheeped, sapped, shackled).
    const active = new Set(living.slice(0, CC_ACTIVE));
    for (const mob of mobs) {
      if (mob.hp <= 0 || !active.has(mob)) continue;
      const tank = members[tankIdx];
      const target = (): number => {
        const holds = tank && !tank.dead && tank.ccUntil <= t && tauntLostUntil <= t;
        if (holds) return tankIdx;
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
        hurt(m, i, Math.round(d.per * (1 - resisted(m, d.school, 60))), -1, events, t);
      }
      m.dots = m.dots.filter(d => d.left > 0);
    });
  }
  setT(t);
  return false;
}

function hurt(m: Member, i: number, amt: number, src: number, events: RunEvent[], t: number, spell?: number): void {
  if (m.dead || amt <= 0) return;
  m.hp -= amt;
  if (m.castEnd) m.castEnd += 500; // spell pushback
  events.push({ t, k: 'hit', src, dst: i, mob: true, amt, ...(spell ? { spell } : {}) });
  if (m.hp <= 0) { m.hp = 0; m.dead = true; m.castEnd = 0; events.push({ t, k: 'die', who: i, mob: false }); }
}

function swing(mob: Mob, dst: number, members: Member[], rng: RngState, t: number, events: RunEvent[]): void {
  const m = members[dst];
  const st = mob.def.stats[mob.level - mob.def.levelMin] ?? mob.def.stats[0];
  const miss = missChance(mob.level * 5, m.snap.defense);
  const dodge = m.snap.dodge + Math.max(0, (m.snap.defense - mob.level * 5) * 0.04);
  const roll = next(rng) * 100;
  if (roll < miss + dodge) return;
  const crit = chance(rng, 5);
  const base = int(rng, st.dmgMin, st.dmgMax) * (1 + mob.enrage / 100) * (crit ? 2 : 1);
  hurt(m, dst, Math.max(1, Math.round(base * (1 - armorReduction(m.snap.armor, mob.level)))), mob.uid, events, t);
}

function applyAbility(eff: AbilityEffect, ab: CreatureAbility, mob: Mob, dst: number, members: Member[], mobs: Mob[], data: GameData,
  rng: RngState, t: number, events: RunEvent[], dropAggro: () => void): void {
  const targets = ab.aoe ? members.map((_, i) => i).filter(i => !members[i].dead) : dst >= 0 ? [dst] : [];
  switch (eff.k) {
    case 'damage':
      for (const i of targets) {
        const m = members[i];
        const raw = int(rng, eff.min, Math.max(eff.min, eff.max)) * (1 + mob.enrage / 100);
        const mitigated = eff.school === 0 ? raw * (1 - armorReduction(m.snap.armor, mob.level)) : raw * (1 - resisted(m, eff.school, mob.level));
        hurt(m, i, Math.round(mitigated), mob.uid, events, t, ab.spell);
      }
      break;
    case 'dot':
      for (const i of targets) members[i].dots.push({ per: eff.perTick * (1000 / Math.max(1000, eff.ampMs)), left: Math.round(eff.ticks * eff.ampMs / 1000), school: eff.school });
      break;
    case 'cc':
      for (const i of targets) { members[i].ccUntil = t + eff.ms; members[i].castEnd = 0; }
      break;
    case 'heal': mob.hp = Math.min(mob.maxHp, mob.hp + eff.amount); break;
    case 'enrage': mob.enrage = Math.min(200, mob.enrage + eff.pct); break;
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

function bossLoot(data: GameData, boss: number, snaps: Snapshot[], rng: RngState): RunLoot[] {
  const def = data.creatures[boss];
  if (!def?.loot) return [];
  const out: RunLoot[] = [];
  for (const [item, count] of rollLoot(data, def.loot, rng)) {
    const it = data.items[item];
    if (!it) continue;
    const rolls = snaps.map((sn, member) => ({ member, roll: int(rng, 1, 100), need: !sn.hireling && canUse(data, sn, it) }))
      .filter(r => !snaps[r.member].hireling);
    const needers = rolls.filter(r => r.need);
    const pool = needers.length ? needers : rolls;
    const best = pool.reduce<typeof pool[number] | null>((a, r) => (!a || r.roll > a.roll ? r : a), null);
    out.push({ item, count, boss, winner: best ? best.member : null, rolls });
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
