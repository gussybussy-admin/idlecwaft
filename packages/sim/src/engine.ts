// The idle engine. `advance` resolves everything that happens between state.now and a target time,
// one discrete event at a time, using only the RNG stored in the state: same state + same target
// time = same result, which is what lets the server simulate and clients replay.
import type { CreatureDef, GameData, ItemDef } from './data.js';
import { factionOfRace } from './data.js';
import { discoverTaxis, planTravel, RIDING } from './travel.js';
import {
  absorb, combatNextAt, combatStep, knownSpells, maxMana, mobMods, passives, RAGE_MAX, rageFrom, syncPower, type CombatCtx,
} from './combat.js';
import { scaled } from './spells.js';
import { activeTalentEffects, learnTalent, resetTalents, type TalentEffect } from './talents.js';
import {
  ARMOR_SKILL, combatSkillupChance, SKILL_DEFENSE, SKILL_UNARMED, WEAPON_SKILL,
  armorReduction, fishingCatchChance, fishingSkillupChance, gatherColor, healthFromStamina,
  healthRegenPerSec, killXp, meleeAttackPower, missChance, recipeColor, SKILLUP_CHANCE, STAT,
} from './formulas.js';
import { rollLoot, type Drops } from './loot.js';
import { chance, int } from './rng.js';
import {
  addItem, hasItem, log, SLOTS, type Action, type GameState, type Mob, type Profession, type Slot,
} from './state.js';

export const OFFLINE_CAP_MS = 24 * 60 * 60 * 1000;
export const SEARCH_MS: [number, number] = [2500, 4500]; // finding the next mob
export const DEATH_MS = 30_000;                          // corpse run
export const REVIVE_HP_FRACTION = 0.1;                   // health after resurrecting at your corpse
export const GATHER_MS = 5000;                           // walk to the node + gather cast
export const FISH_MS: [number, number] = [5000, 18000];  // bobber wait
export const CRAFT_PAD_MS = 500;                         // between crafts

// ---------------------------------------------------------------- events

export type SimEvent =
  | { t: number; type: 'spawn'; mob: Mob }
  | { t: number; type: 'swing'; who: 'player' | 'mob'; result: 'hit' | 'crit' | 'miss' | 'dodge'; dmg: number; spell?: number }
  | { t: number; type: 'heal'; amount: number; spell: number }
  | { t: number; type: 'kill'; creature: number; xp: number; gold: number; items: [number, number][] }
  | { t: number; type: 'death' }
  | { t: number; type: 'revive' }
  | { t: number; type: 'levelup'; level: number }
  | { t: number; type: 'skillup'; skill: Profession; level: number }
  | { t: number; type: 'harvest'; skill: Profession; items: [number, number][] }
  | { t: number; type: 'escape' } // a fish got away
  | { t: number; type: 'eat'; item: number }
  | { t: number; type: 'stop'; reason: string }
  | { t: number; type: 'arrive'; zone: number }
  | { t: number; type: 'combatskill'; skill: number; level: number };

export interface Summary {
  ms: number; xp: number; gold: number; kills: number; deaths: number; levels: number;
  items: Record<number, number>; skillups: Partial<Record<Profession, number>>;
}

export function emptySummary(): Summary {
  return { ms: 0, xp: 0, gold: 0, kills: 0, deaths: 0, levels: 0, items: {}, skillups: {} };
}

export function summarize(sum: Summary) {
  return (e: SimEvent) => {
    switch (e.type) {
      case 'kill': sum.kills++; sum.xp += e.xp; sum.gold += e.gold; for (const [i, n] of e.items) sum.items[i] = (sum.items[i] ?? 0) + n; break;
      case 'harvest': for (const [i, n] of e.items) sum.items[i] = (sum.items[i] ?? 0) + n; break;
      case 'death': sum.deaths++; break;
      case 'levelup': sum.levels++; break;
      case 'skillup': sum.skillups[e.skill] = (sum.skillups[e.skill] ?? 0) + 1; break;
    }
  };
}

// ---------------------------------------------------------------- derived stats

export interface PlayerStats {
  str: number; agi: number; sta: number; int: number; spi: number;
  maxHp: number; maxMana: number; ap: number; armor: number;
  dmgMin: number; dmgMax: number; speedMs: number;
  crit: number; spellCrit: number; meleeHit: number; spellHit: number; dodge: number; regenPerSec: number;
}

export function playerStats(s: GameState, data: GameData): PlayerStats {
  const { race, cls, level } = s.char;
  const base = data.levelStats[race]?.[cls]?.[level] ?? [20, 20, 20, 20, 20];
  let [str, agi, sta, int_, spi] = base;
  let armor = 0;
  for (const slot of SLOTS) {
    const it = s.equipment[slot] ? data.items[s.equipment[slot]!] : undefined;
    if (!it) continue;
    armor += it.armor;
    for (const [type, v] of it.stats) {
      if (type === STAT.STR) str += v; else if (type === STAT.AGI) agi += v; else if (type === STAT.STA) sta += v;
      else if (type === STAT.INT) int_ += v; else if (type === STAT.SPI) spi += v;
    }
  }
  // Known self buffs (Battle Shout, Arcane Intellect, Fortitude, Devotion Aura, ...) are always on.
  const p = passives(s, data);
  str += p.str; agi += p.agi; sta += p.sta; int_ += p.int; spi += p.spi;
  // Talents: flat stats first, then percentages (Strength of the Earth-style % talents multiply the total).
  const tal = activeTalentEffects(s, data);
  const sum = (k: TalentEffect['k'], f: (e: TalentEffect) => number) => tal.filter(e => e.k === k).reduce((a, e) => a + f(e), 0);
  const statOf = (e: TalentEffect, which: string) => ('stat' in e && (e.stat === which || e.stat === 'all'));
  str += sum('stat', e => statOf(e, 'str') ? (e as { amount: number }).amount : 0);
  agi += sum('stat', e => statOf(e, 'agi') ? (e as { amount: number }).amount : 0);
  sta += sum('stat', e => statOf(e, 'sta') ? (e as { amount: number }).amount : 0);
  int_ += sum('stat', e => statOf(e, 'int') ? (e as { amount: number }).amount : 0);
  spi += sum('stat', e => statOf(e, 'spi') ? (e as { amount: number }).amount : 0);
  const pct = (which: string) => 1 + sum('statPct', e => statOf(e, which) ? (e as { pct: number }).pct : 0) / 100;
  str = Math.round(str * pct('str')); agi = Math.round(agi * pct('agi')); sta = Math.round(sta * pct('sta'));
  int_ = Math.round(int_ * pct('int')); spi = Math.round(spi * pct('spi'));
  armor += agi * 2 + p.armor + sum('armor', e => (e as { amount: number }).amount);
  armor = Math.round(armor * (1 + sum('armorPct', e => (e as { pct: number }).pct) / 100));
  const baseHp = data.classStats[cls]?.[level]?.[0] ?? 20;
  const ap = meleeAttackPower(cls, level, str, agi) + p.ap + sum('ap', e => (e as { amount: number }).amount);
  const weapon = s.equipment.mainhand ? data.items[s.equipment.mainhand] : undefined;
  const speedMs = weapon?.delayMs || 2000;
  const bonus = (ap / 14) * (speedMs / 1000);
  return {
    str, agi, sta, int: int_, spi, armor, ap, speedMs,
    maxHp: Math.round((baseHp + healthFromStamina(sta)) * (1 + sum('healthPct', e => (e as { pct: number }).pct) / 100)),
    maxMana: Math.round(maxMana(s, data, int_) * (1 + sum('manaPct', e => (e as { pct: number }).pct) / 100)),
    dmgMin: Math.max(1, Math.round((weapon?.dmgMin || 1) + bonus)),
    dmgMax: Math.max(1, Math.round((weapon?.dmgMax || 2) + bonus)),
    crit: Math.min(60, 5 + agi / 20 + sum('meleeCrit', e => (e as { pct: number }).pct)),
    spellCrit: Math.min(50, 5 + int_ / 60 + sum('spellCrit', e => (e as { pct: number }).pct)),
    meleeHit: sum('meleeHit', e => (e as { pct: number }).pct),
    spellHit: sum('spellHit', e => (e as { pct: number }).pct),
    dodge: Math.min(40, agi / 20 + sum('dodge', e => (e as { pct: number }).pct)),
    regenPerSec: healthRegenPerSec(spi),
  };
}

// ---------------------------------------------------------------- advance

type Emit = (e: SimEvent) => void;

/** Resolve everything up to `to` (ms). Returns the number of events processed. */
export function advance(s: GameState, data: GameData, to: number, emit: Emit = () => {}): number {
  let events = 0;
  for (let guard = 0; guard < 5_000_000; guard++) {
    const at = nextEventAt(s, data);
    if (at === null || at > to) { regen(s, data, to); s.now = Math.max(s.now, to); return events; }
    regen(s, data, at);
    s.now = Math.max(s.now, at);
    step(s, data, emit);
    events++;
  }
  throw new Error('advance: runaway simulation');
}

/**
 * Offline catch-up: progress is capped at OFFLINE_CAP_MS. Time beyond the cap is skipped, not
 * simulated, so the character resumes exactly where the capped window ends.
 */
export function catchUp(s: GameState, data: GameData, wallNow: number, emit?: Emit): Summary {
  const sum = emptySummary();
  if (wallNow - s.now > OFFLINE_CAP_MS) s.now = wallNow - OFFLINE_CAP_MS;
  const from = s.now;
  const collect = summarize(sum);
  advance(s, data, wallNow, e => { collect(e); emit?.(e); });
  sum.ms = wallNow - from;
  return sum;
}

function nextEventAt(s: GameState, data: GameData): number | null {
  const ph = s.phase;
  switch (ph.p) {
    case 'idle': return s.action ? s.now : null;
    case 'search': case 'dead': case 'work': return ph.until;
    case 'combat': return combatNextAt(ph);
    case 'rest': {
      const st = playerStats(s, data);
      if (s.char.hp >= st.maxHp) return s.now;
      const eat = ph.eating;
      if (eat && eat.until <= s.now) return s.now; // finished eating: decide whether to eat again
      if (!eat) {
        // No food: wake on every slow-regen tick (to eat if food turned up) until the rest goal.
        return ticksAfter(s.now, BASE_REGEN_MS);
      }
      // Walk food ticks until full or until the meal ends (a meal lasts seconds, so this is short).
      let hp = s.char.hp;
      for (let tick = ticksAfter(s.now, REGEN_TICK_MS); ; tick += REGEN_TICK_MS) {
        if (eat.until < tick) return eat.until;
        hp += eat.perTick + (tick % BASE_REGEN_MS === 0 ? 1 : 0);
        if (hp >= st.maxHp) return tick;
      }
    }
  }
}

/**
 * Healing outside combat is food. Natural regeneration is only 1 HP per minute, so fishing and cooking
 * are what keep a fighter going. Both kinds of tick are aligned to absolute time and heal whole
 * points, which keeps the result independent of how time is chunked.
 */
export const REGEN_TICK_MS = 2000;       // food heals on these ticks
export const BASE_REGEN_MS = 60_000;     // 1 HP of natural regeneration per tick
const ticksAfter = (t: number, period: number) => (Math.floor(t / period) + 1) * period;
const ticksBetween = (from: number, to: number, period: number) => Math.max(0, Math.floor(to / period) - Math.floor(from / period));

function regen(s: GameState, data: GameData, to: number): void {
  const ph = s.phase;
  if (to <= s.now || ph.p === 'combat' || ph.p === 'dead') return;
  let gain = ticksBetween(s.now, to, BASE_REGEN_MS);
  if (ph.p === 'rest' && ph.eating) gain += ticksBetween(s.now, Math.min(to, ph.eating.until), REGEN_TICK_MS) * ph.eating.perTick;
  if (!gain) return;
  s.char.hp = Math.min(playerStats(s, data).maxHp, s.char.hp + gain);
}

function step(s: GameState, data: GameData, emit: Emit): void {
  const st = playerStats(s, data);
  syncPower(s, data, s.now, st.spi, st.int);
  const a = s.action;
  if (!a) { s.phase = { p: 'idle' }; return; }
  switch (a.kind) {
    case 'fight': return stepFight(s, data, a.creature, emit);
    case 'gather': return stepGather(s, data, a.node, emit);
    case 'fish': return stepFish(s, data, emit);
    case 'cook': return stepCook(s, data, a.recipe, emit);
    case 'travel': return stepTravel(s, data, a.to, emit);
  }
}

function stop(s: GameState, reason: string, emit: Emit): void {
  s.action = null;
  s.phase = { p: 'idle' };
  log(s, 'warn', reason);
  emit({ t: s.now, type: 'stop', reason });
}

// ---------------------------------------------------------------- combat

function stepFight(s: GameState, data: GameData, creatureId: number, emit: Emit): void {
  const def = data.creatures[creatureId];
  if (!def) return stop(s, 'That creature no longer exists.', emit);
  const ph = s.phase;
  const st = playerStats(s, data);

  if (ph.p === 'idle') {
    if (s.char.hp < st.maxHp * s.settings.restBelowPct / 100) return startRest(s, data, emit);
    s.phase = { p: 'search', from: s.now, until: s.now + int(s.rng, ...SEARCH_MS) };
    return;
  }
  if (ph.p === 'search') {
    const level = int(s.rng, def.levelMin, def.levelMax);
    const hp = def.stats[level - def.levelMin].hp;
    const mob: Mob = { id: def.id, level, hp, maxHp: hp };
    s.phase = { p: 'combat', mob, playerSwingAt: s.now + 300, mobSwingAt: s.now + 800, decideAt: s.now + 100 };
    emit({ t: s.now, type: 'spawn', mob: { ...mob } });
    return;
  }
  if (ph.p === 'dead') {
    // Resurrecting is not a heal: you come back weak and need food (or a long rest).
    s.char.hp = Math.max(1, Math.ceil(st.maxHp * REVIVE_HP_FRACTION));
    log(s, 'info', 'You return to your corpse and resurrect.');
    emit({ t: s.now, type: 'revive' });
    return startRest(s, data, emit);
  }
  if (ph.p === 'rest') {
    const goal = st.maxHp * s.settings.restBelowPct / 100;
    if (s.char.hp >= st.maxHp) {
      s.phase = { p: 'search', from: s.now, until: s.now + int(s.rng, ...SEARCH_MS) };
      return;
    }
    if (ph.eating && s.now >= ph.eating.until) ph.eating = undefined; // finished eating: eat again if still hurt
    if (!ph.eating) {
      maybeEat(s, data, emit);
      // Without food you only wait until you're fit enough to fight again.
      if (!ph.eating && s.char.hp >= goal) s.phase = { p: 'search', from: s.now, until: s.now + int(s.rng, ...SEARCH_MS) };
    }
    return;
  }
  if (ph.p !== 'combat') { s.phase = { p: 'idle' }; return; }

  const mob = ph.mob;
  const stats = def.stats[mob.level - def.levelMin];
  const ctx: CombatCtx = {
    data, def,
    st: { dmgMin: st.dmgMin, dmgMax: st.dmgMax, speedMs: st.speedMs, crit: st.crit, spellCrit: st.spellCrit, meleeHit: st.meleeHit,
      spellHit: st.spellHit, ap: st.ap, int: st.int, spi: st.spi, level: s.char.level, maxHp: st.maxHp },
    talents: activeTalentEffects(s, data),
    emitSwing: (who, result, dmg, spell) => emit({ t: s.now, type: 'swing', who, result, dmg, ...(spell ? { spell } : {}) }),
    emitHeal: (amount, spell) => emit({ t: s.now, type: 'heal', amount, spell }),
    raiseWeaponSkill: () => {
      const wskill = weaponSkillId(s, data);
      const skill = s.combatSkills[wskill] ?? 1;
      raiseCombatSkill(s, wskill, emit);
      return skill;
    },
  };
  const outcome = combatStep(s, ph, ctx);
  if (outcome === 'killed') return onKill(s, data, def, mob, emit);
  if (outcome !== 'mob-swing') return;

  // The mob swings: its weapon skill (5 per level) against your Defense, which rises as you're attacked.
  const r = s.rng;
  let result: 'hit' | 'crit' | 'miss' | 'dodge', dmg = 0;
  const defense = s.combatSkills[SKILL_DEFENSE] ?? 1;
  const miss = missChance(mob.level * 5, defense);
  const roll = int(r, 0, 9999) / 100;
  raiseCombatSkill(s, SKILL_DEFENSE, emit);
  const mods = mobMods(ph, def.attackMs);
  if (roll < miss) result = 'miss';
  else if (roll < miss + st.dodge + Math.max(0, (defense - mob.level * 5) * 0.04)) result = 'dodge';
  else {
    dmg = Math.max(1, int(r, stats.dmgMin, stats.dmgMax) + mods.dmgDelta);
    result = chance(r, 5) ? 'crit' : 'hit';
    if (result === 'crit') dmg *= 2;
    dmg = Math.max(1, Math.round(dmg * (1 - armorReduction(st.armor, mob.level))));
  }
  if (result === 'miss' || result === 'dodge') ph.selfAvoidedAt = s.now;
  dmg = absorb(ph, dmg);
  s.char.hp -= dmg;
  ph.mobSwingAt = s.now + mods.attackMs;
  emit({ t: s.now, type: 'swing', who: 'mob', result, dmg });
  if (dmg > 0 && s.char.cls === 1) s.char.rage = Math.min(RAGE_MAX, (s.char.rage ?? 0) + rageFrom(dmg, s.char.level, false));
  const thorns = passives(s, data).thorns;
  if (thorns && (result === 'hit' || result === 'crit')) {
    mob.hp -= thorns;
    emit({ t: s.now, type: 'swing', who: 'player', result: 'hit', dmg: thorns });
  }
  ph.decideAt = Math.min(ph.decideAt ?? Infinity, s.now);
  if (s.char.hp <= 0) {
    s.char.hp = 0;
    s.char.rage = 0;
    s.stats.deaths++;
    log(s, 'death', `You were slain by ${def.name}.`);
    emit({ t: s.now, type: 'death' });
    s.phase = { p: 'dead', from: s.now, until: s.now + DEATH_MS };
    return;
  }
  if (mob.hp <= 0) return onKill(s, data, def, mob, emit);
}

/** The weapon skill your current main hand uses (Unarmed without a weapon). */
export function weaponSkillId(s: GameState, data: GameData): number {
  const w = s.equipment.mainhand ? data.items[s.equipment.mainhand] : undefined;
  return (w && w.class === 2 && WEAPON_SKILL[w.subclass]) || SKILL_UNARMED;
}

function raiseCombatSkill(s: GameState, skill: number, emit: Emit): void {
  const cur = s.combatSkills[skill] ?? 1, max = s.char.level * 5;
  if (!chance(s.rng, combatSkillupChance(cur, max))) return;
  s.combatSkills[skill] = cur + 1;
  emit({ t: s.now, type: 'combatskill', skill, level: cur + 1 });
}

function onKill(s: GameState, data: GameData, def: CreatureDef, mob: Mob, emit: Emit): void {
  s.char.rage = 0; // rage fades out of combat
  const xp = s.char.level < data.maxLevel ? killXp(s.char.level, mob.level, def.rank) : 0;
  const gold = def.goldMax ? int(s.rng, def.goldMin, def.goldMax) : 0;
  const drops = rollLoot(data, def.loot, s.rng);
  s.gold += gold;
  for (const [i, n] of drops) addItem(s, i, n);
  s.stats.kills[def.id] = (s.stats.kills[def.id] ?? 0) + 1;
  const items = [...drops];
  emit({ t: s.now, type: 'kill', creature: def.id, xp, gold, items });
  if (items.length) log(s, 'loot', `${def.name}: ${items.map(([i, n]) => `${data.items[i]?.name ?? i}${n > 1 ? ` x${n}` : ''}`).join(', ')}`);
  gainXp(s, data, xp, emit);
  const st = playerStats(s, data);
  if (s.char.hp < st.maxHp * s.settings.restBelowPct / 100) startRest(s, data, emit);
  else s.phase = { p: 'search', from: s.now, until: s.now + int(s.rng, ...SEARCH_MS) };
}

function gainXp(s: GameState, data: GameData, xp: number, emit: Emit): void {
  if (!xp) return;
  s.char.xp += xp;
  while (s.char.level < data.maxLevel && s.char.xp >= data.xpToNext[s.char.level]) {
    s.char.xp -= data.xpToNext[s.char.level];
    s.char.level++;
    s.char.hp = playerStats(s, data).maxHp;
    log(s, 'level', `You have reached level ${s.char.level}!`);
    emit({ t: s.now, type: 'levelup', level: s.char.level });
  }
  if (s.char.level >= data.maxLevel) s.char.xp = 0;
}

function startRest(s: GameState, data: GameData, emit: Emit): void {
  s.phase = { p: 'rest' };
  maybeEat(s, data, emit);
}

/** Eat the smallest food that tops you up, or the biggest one you have. */
function maybeEat(s: GameState, data: GameData, emit: Emit): void {
  const ph = s.phase;
  if (ph.p !== 'rest' || ph.eating || !s.settings.autoEat) return;
  const st = playerStats(s, data);
  drinkIfNeeded(s, data, st, emit);
  const missing = st.maxHp - s.char.hp;
  if (missing <= 0) return;
  const edible = () => Object.keys(s.inventory).map(Number).map(id => data.items[id])
    .filter((it): it is ItemDef => !!it?.food?.heal && it.reqLevel <= s.char.level)
    .sort((a, b) => a.food!.heal - b.food!.heal);
  let foods = edible();
  if (!foods.length && conjure(s, data, 'heal', emit)) foods = edible();
  if (!foods.length) return;
  const pick = foods.find(f => f.food!.heal >= missing) ?? foods[foods.length - 1];
  addItem(s, pick.id, -1);
  const ticks = Math.max(1, Math.round(pick.food!.durationMs / REGEN_TICK_MS));
  ph.eating = { item: pick.id, perTick: Math.max(1, Math.round(pick.food!.heal / ticks)), until: s.now + pick.food!.durationMs };
  emit({ t: s.now, type: 'eat', item: pick.id });
}

/**
 * Casters drink while resting when below half mana. (Mana from a drink is applied when you sit down;
 * health from food still arrives tick by tick, since food is the only way health comes back.)
 */
function drinkIfNeeded(s: GameState, data: GameData, st: PlayerStats, emit: Emit): void {
  if (!st.maxMana || (s.char.mana ?? 0) >= st.maxMana * 0.5) return;
  const drinks = () => Object.keys(s.inventory).map(Number).map(id => data.items[id])
    .filter((it): it is ItemDef => !!it?.food?.mana && it.reqLevel <= s.char.level).sort((a, b) => a.food!.mana - b.food!.mana);
  let list = drinks();
  if (!list.length && conjure(s, data, 'mana', emit)) list = drinks();
  const missing = st.maxMana - (s.char.mana ?? 0);
  const pick = list.find(d => d.food!.mana >= missing) ?? list[list.length - 1];
  if (!pick) return;
  addItem(s, pick.id, -1);
  s.char.mana = Math.min(st.maxMana, (s.char.mana ?? 0) + pick.food!.mana);
  emit({ t: s.now, type: 'eat', item: pick.id });
}

/** Conjure Food / Water (mages): make a stack from mana when you've run out. */
function conjure(s: GameState, data: GameData, want: 'heal' | 'mana', emit: Emit): boolean {
  for (const sp of knownSpells(s, data)) {
    for (const e of sp.effects) {
      if (e.k !== 'conjure') continue;
      const it = data.items[e.item];
      if (!it?.food || !(want === 'heal' ? it.food.heal : it.food.mana)) continue;
      if ((s.char.mana ?? 0) < sp.cost) return false;
      s.char.mana = (s.char.mana ?? 0) - sp.cost;
      s.char.lastCastAt = s.now;
      addItem(s, e.item, Math.max(1, Math.round(scaled(e.count, e.perLevel, sp, s.char.level))));
      log(s, 'info', `You conjure ${it.name}.`);
      emit({ t: s.now, type: 'harvest', skill: 'cooking', items: [[e.item, 1]] });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- professions

function skillUp(s: GameState, skill: Profession, pct: number, emit: Emit): void {
  const sk = s.skills[skill];
  if (sk.level >= sk.max || !chance(s.rng, pct)) return;
  sk.level++;
  log(s, 'skill', `Your skill in ${cap(skill)} has increased to ${sk.level}.`);
  emit({ t: s.now, type: 'skillup', skill, level: sk.level });
}

function stepGather(s: GameState, data: GameData, nodeId: number, emit: Emit): void {
  const node = data.nodes[nodeId];
  if (!node) return stop(s, 'Unknown node.', emit);
  if (s.phase.p !== 'work') {
    const err = canGather(s, data, nodeId);
    if (err) return stop(s, err, emit);
    s.phase = { p: 'work', from: s.now, until: s.now + GATHER_MS };
    return;
  }
  const drops = rollLoot(data, node.loot, s.rng);
  for (const [i, n] of drops) addItem(s, i, n);
  s.stats.gathered++;
  emit({ t: s.now, type: 'harvest', skill: node.skill, items: [...drops] });
  skillUp(s, node.skill, SKILLUP_CHANCE[gatherColor(s.skills[node.skill].level, node.reqSkill)], emit);
  s.phase = { p: 'idle' };
}

function stepFish(s: GameState, data: GameData, emit: Emit): void {
  const zone = data.zones.find(z => z.id === s.zone);
  if (s.phase.p !== 'work') {
    const err = canFish(s, data);
    if (err) return stop(s, err, emit);
    s.phase = { p: 'work', from: s.now, until: s.now + int(s.rng, ...FISH_MS) };
    return;
  }
  const skill = s.skills.fishing.level;
  if (zone?.fishing && chance(s.rng, fishingCatchChance(skill, zone.fishing.zoneSkill))) {
    const drops = rollLoot(data, zone.fishing.loot, s.rng);
    for (const [i, n] of drops) addItem(s, i, n);
    s.stats.caught++;
    emit({ t: s.now, type: 'harvest', skill: 'fishing', items: [...drops] });
    skillUp(s, 'fishing', fishingSkillupChance(skill), emit);
  } else {
    emit({ t: s.now, type: 'escape' });
  }
  s.phase = { p: 'idle' };
}

function stepCook(s: GameState, data: GameData, recipeId: number, emit: Emit): void {
  const r = data.recipes[recipeId];
  if (!r) return stop(s, 'Unknown recipe.', emit);
  if (s.phase.p !== 'work') {
    const err = canCook(s, data, recipeId);
    if (err) return stop(s, err, emit);
    s.phase = { p: 'work', from: s.now, until: s.now + r.castMs + CRAFT_PAD_MS };
    return;
  }
  for (const [i, n] of r.reagents) addItem(s, i, -n);
  addItem(s, r.item, r.count);
  s.stats.cooked++;
  emit({ t: s.now, type: 'harvest', skill: 'cooking', items: [[r.item, r.count]] });
  skillUp(s, 'cooking', SKILLUP_CHANCE[recipeColor(s.skills.cooking.level, r)], emit);
  s.phase = { p: 'idle' };
}

// ---------------------------------------------------------------- validation

export function canGather(s: GameState, data: GameData, nodeId: number): string | null {
  const node = data.nodes[nodeId];
  if (!node) return 'Unknown node.';
  const sk = s.skills[node.skill];
  if (!sk.max) return `You need to train ${cap(node.skill)} first.`;
  if (sk.level < node.reqSkill) return `Requires ${cap(node.skill)} ${node.reqSkill}.`;
  if (node.skill === 'mining' && !hasTool(s, data, 'mining-pick')) return 'Requires a Mining Pick.';
  if (!data.zones.find(z => z.id === s.zone)?.nodes.some(n => n.id === nodeId)) return `There is no ${node.name} here.`;
  return null;
}

export function canFish(s: GameState, data: GameData): string | null {
  if (!s.skills.fishing.max) return 'You need to train Fishing first.';
  if (!hasTool(s, data, 'fishing-pole')) return 'Requires a Fishing Pole.';
  if (!data.zones.find(z => z.id === s.zone)?.fishing) return 'There is nowhere to fish here.';
  return null;
}

export function canCook(s: GameState, data: GameData, recipeId: number): string | null {
  const r = data.recipes[recipeId];
  if (!r) return 'Unknown recipe.';
  if (!s.skills.cooking.max) return 'You need to train Cooking first.';
  if (!s.recipes.includes(recipeId)) return `You don't know ${r.name}.`;
  for (const [i, n] of r.reagents) if (!hasItem(s, i, n)) return `Out of ${data.items[i]?.name ?? 'reagents'}.`;
  return null;
}

export function canFight(s: GameState, data: GameData, creatureId: number): string | null {
  if (!data.zones.find(z => z.id === s.zone)?.creatures.some(c => c.id === creatureId)) return 'That creature is not in this zone.';
  if (!data.creatures[creatureId]?.hostile.includes(factionOfRace(data, s.char.race))) return 'You cannot attack that.';
  return null;
}

export function canTravel(s: GameState, data: GameData, to: number): string | null {
  if (to === s.zone) return "You're already there.";
  const plan = planTravel(s, data, to);
  if (!plan) return 'There is no way to get there from here.';
  if (s.gold < plan.cost) return `The flight costs ${formatMoney(plan.cost)}.`;
  return null;
}

// ---------------------------------------------------------------- travel

function stepTravel(s: GameState, data: GameData, to: number, emit: Emit): void {
  if (s.phase.p !== 'work') {
    const err = canTravel(s, data, to);
    if (err) return stop(s, err, emit);
    const plan = planTravel(s, data, to)!;
    s.gold -= plan.cost;
    s.phase = { p: 'work', from: s.now, until: s.now + Math.max(1000, plan.ms) };
    return;
  }
  s.zone = to;
  const zone = data.zones.find(z => z.id === to);
  log(s, 'info', `You arrive in ${zone?.name ?? 'a new zone'}.`);
  emit({ t: s.now, type: 'arrive', zone: to });
  discoverTaxis(s, data);
  s.action = null;
  s.phase = { p: 'idle' };
}

/** Spells your class trainer would teach you now (level reached, not yet known). */
export function trainableSpells(s: GameState, data: GameData) {
  return (data.classSpells?.[s.char.cls] ?? []).filter(o => o.level <= s.char.level && !s.spells.includes(o.spell));
}

/** Learn everything your class trainer offers at your level, cheapest first, while the money lasts. */
export function trainSpells(s: GameState, data: GameData): CommandResult {
  if (!(data.classTrainerZones?.[s.char.cls] ?? []).includes(s.zone)) {
    const cls = data.classes.find(c => c.id === s.char.cls)?.name ?? 'class';
    return fail(`There's no ${cls.toLowerCase()} trainer here.`);
  }
  const offers = trainableSpells(s, data).sort((a, b) => a.cost - b.cost);
  if (!offers.length) return fail('You have nothing new to learn yet.');
  let learned = 0;
  for (const o of offers) {
    if (s.gold < o.cost) break;
    s.gold -= o.cost;
    s.spells.push(o.spell);
    learned++;
  }
  if (!learned) return fail(`Training costs ${formatMoney(offers[0].cost)}.`);
  log(s, 'skill', `You learned ${learned} new spell${learned > 1 ? 's' : ''}${learned < offers.length ? ` (${offers.length - learned} more when you can afford them)` : ''}.`);
  return ok;
}

export function trainRiding(s: GameState): CommandResult {
  const next = RIDING.find(r => r.bonus > s.riding);
  if (!next) return fail('You already ride as fast as anyone.');
  if (s.char.level < next.reqLevel) return fail(`Requires level ${next.reqLevel}.`);
  if (s.gold < next.cost) return fail(`${next.name} and a mount cost ${formatMoney(next.cost)}.`);
  s.gold -= next.cost;
  s.riding = next.bonus;
  log(s, 'skill', `You learned ${next.name}: travel is ${next.bonus}% faster.`);
  return ok;
}

function hasTool(s: GameState, data: GameData, tool: string): boolean {
  return Object.keys(s.inventory).some(id => data.items[+id]?.tool === tool)
    || SLOTS.some(slot => s.equipment[slot] && data.items[s.equipment[slot]!]?.tool === tool);
}

// ---------------------------------------------------------------- commands (validated, deterministic)

export type CommandResult = { ok: true } | { ok: false; error: string };
const ok: CommandResult = { ok: true };
const fail = (error: string): CommandResult => ({ ok: false, error });

export function startAction(s: GameState, data: GameData, action: Action): CommandResult {
  const err = action.kind === 'fight' ? canFight(s, data, action.creature)
    : action.kind === 'gather' ? canGather(s, data, action.node)
    : action.kind === 'fish' ? canFish(s, data)
    : action.kind === 'travel' ? canTravel(s, data, action.to)
    : canCook(s, data, action.recipe);
  if (err) return fail(err);
  if (s.phase.p === 'dead') return fail('You are dead. Wait to resurrect.');
  if (s.action?.kind === 'travel' && s.phase.p === 'work') return fail("You're travelling. Wait until you arrive.");
  s.action = action;
  if (s.phase.p !== 'rest' || action.kind === 'travel') s.phase = { p: 'idle' };
  return ok;
}

export function stopAction(s: GameState): CommandResult {
  if (s.phase.p === 'dead') return fail('You are dead. Wait to resurrect.');
  if (s.action?.kind === 'travel' && s.phase.p === 'work') return fail("You're travelling. Wait until you arrive.");
  s.action = null;
  s.phase = { p: 'idle' };
  return ok;
}

export function train(s: GameState, data: GameData, skill: Profession): CommandResult {
  const ranks = data.skillRanks[skill];
  const sk = s.skills[skill];
  const next = ranks.find(r => r.max > sk.max);
  if (!next) return fail('Already at the highest rank.');
  if (sk.max && sk.level < sk.max - 25) return fail(`Requires ${cap(skill)} ${sk.max - 25} to train ${next.name}.`);
  if (s.char.level < next.reqLevel) return fail(`Requires level ${next.reqLevel}.`);
  if (s.gold < next.cost) return fail(`Costs ${formatMoney(next.cost)}.`);
  s.gold -= next.cost;
  sk.max = next.max;
  if (!sk.level) sk.level = 1;
  if (skill === 'cooking') {
    for (const r of Object.values(data.recipes)) {
      if ('trainer' in r.source && r.source.trainer === 0 && !s.recipes.includes(r.spellId)) s.recipes.push(r.spellId);
    }
  }
  log(s, 'skill', `You are now ${/^[AEIOU]/.test(next.name) ? 'an' : 'a'} ${next.name} in ${cap(skill)} (max ${next.max}).`);
  return ok;
}

export function learnRecipe(s: GameState, data: GameData, recipeId: number): CommandResult {
  const r = data.recipes[recipeId];
  if (!r) return fail('Unknown recipe.');
  if (s.recipes.includes(recipeId)) return fail('Already known.');
  if (!s.skills.cooking.max) return fail('Train Cooking first.');
  if (s.skills.cooking.level < r.orange) return fail(`Requires Cooking ${r.orange}.`);
  if ('trainer' in r.source) {
    if (s.gold < r.source.trainer) return fail(`Costs ${formatMoney(r.source.trainer)}.`);
    s.gold -= r.source.trainer;
  } else {
    if (!hasItem(s, r.source.recipeItem)) return fail(`Requires ${data.items[r.source.recipeItem]?.name ?? 'the recipe'}.`);
    addItem(s, r.source.recipeItem, -1);
  }
  s.recipes.push(recipeId);
  log(s, 'skill', `You have learned how to create ${r.name}.`);
  return ok;
}

export function buy(s: GameState, data: GameData, item: number, count = 1): CommandResult {
  const zone = data.zones.find(z => z.id === s.zone);
  const faction = factionOfRace(data, s.char.race);
  if (!zone?.vendorItems.some(v => v.item === item && v.factions.includes(faction))) return fail('No vendor here will sell that to you.');
  if (!Number.isInteger(count) || count < 1) return fail('Invalid amount.');
  const it = data.items[item];
  const cost = it.buyPrice * count;
  if (s.gold < cost) return fail(`Costs ${formatMoney(cost)}.`);
  s.gold -= cost;
  addItem(s, item, count);
  return ok;
}

export function sell(s: GameState, data: GameData, item: number, count = 1): CommandResult {
  const it = data.items[item];
  if (!it || !hasItem(s, item, count)) return fail("You don't have that.");
  if (!it.sellPrice) return fail('No vendor will buy that.');
  addItem(s, item, -count);
  s.gold += it.sellPrice * count;
  return ok;
}

// Equip slot(s) for each inventory type.
const INV_SLOTS: Record<number, Slot[]> = {
  1: ['head'], 2: ['neck'], 3: ['shoulders'], 5: ['chest'], 6: ['waist'], 7: ['legs'], 8: ['feet'], 9: ['wrist'],
  10: ['hands'], 11: ['finger1', 'finger2'], 12: ['trinket1', 'trinket2'], 13: ['mainhand'], 14: ['offhand'],
  15: ['ranged'], 16: ['back'], 17: ['mainhand'], 20: ['chest'], 21: ['mainhand'], 22: ['offhand'], 23: ['offhand'],
  25: ['ranged'], 26: ['ranged'],
};
export const TWO_HAND = 17;

export function equipSlots(it: ItemDef): Slot[] { return INV_SLOTS[it.invType] ?? []; }

/** The proficiency an item needs (weapon or armor skill), if any. */
export function proficiencyFor(it: ItemDef): number | null {
  if (it.class === 2 && it.subclass !== 20) return WEAPON_SKILL[it.subclass] ?? null; // fishing poles need none
  if (it.class === 4 && it.invType !== 16) return ARMOR_SKILL[it.subclass] ?? null;   // cloaks are cloth for everyone
  return null;
}

export function equip(s: GameState, data: GameData, item: number): CommandResult {
  const it = data.items[item];
  if (!it || !hasItem(s, item)) return fail("You don't have that.");
  const slots = equipSlots(it);
  if (!slots.length) return fail("You can't equip that.");
  if (it.reqLevel > s.char.level) return fail(`Requires level ${it.reqLevel}.`);
  const prof = proficiencyFor(it);
  const allowed = data.classSkills?.[s.char.cls];
  if (prof && allowed) {
    const name = data.skillNames?.[prof] ?? 'that';
    if (allowed[prof] === undefined) return fail(`${data.classes.find(c => c.id === s.char.cls)?.name ?? 'Your class'}s can't use ${name}.`);
    if (allowed[prof] > s.char.level) return fail(`You learn ${name} at level ${allowed[prof]}.`);
  }
  // A weapon type you've never used starts at skill 1, as in vanilla.
  if (prof && it.class === 2 && !s.combatSkills[prof]) s.combatSkills[prof] = 1;
  if (s.phase.p === 'combat') return fail("You can't change equipment in combat.");
  const slot = slots.find(sl => !s.equipment[sl]) ?? slots[0];
  addItem(s, item, -1);
  if (s.equipment[slot]) addItem(s, s.equipment[slot]!, 1);
  s.equipment[slot] = item;
  if (slot === 'mainhand' && it.invType === TWO_HAND && s.equipment.offhand) { addItem(s, s.equipment.offhand, 1); delete s.equipment.offhand; }
  if (slot === 'offhand' && s.equipment.mainhand && data.items[s.equipment.mainhand]?.invType === TWO_HAND) {
    addItem(s, s.equipment.mainhand, 1); delete s.equipment.mainhand;
  }
  s.char.hp = Math.min(s.char.hp, playerStats(s, data).maxHp);
  return ok;
}

export function unequip(s: GameState, data: GameData, slot: Slot): CommandResult {
  const id = s.equipment[slot];
  if (!id) return fail('Nothing equipped there.');
  if (s.phase.p === 'combat') return fail("You can't change equipment in combat.");
  addItem(s, id, 1);
  delete s.equipment[slot];
  s.char.hp = Math.min(s.char.hp, playerStats(s, data).maxHp);
  return ok;
}

// ---------------------------------------------------------------- helpers

export function formatMoney(copper: number): string {
  const g = Math.floor(copper / 10000), sv = Math.floor((copper % 10000) / 100), c = copper % 100;
  return [g && `${g}g`, sv && `${sv}s`, (c || (!g && !sv)) && `${c}c`].filter(Boolean).join(' ');
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
