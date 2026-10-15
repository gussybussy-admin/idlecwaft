// The idle engine. `advance` resolves everything that happens between state.now and a target time,
// one discrete event at a time, using only the RNG stored in the state: same state + same target
// time = same result, which is what lets the server simulate and clients replay.
import type { CreatureDef, GameData, ItemDef } from './data.js';
import {
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
export const GATHER_MS = 5000;                           // walk to the node + gather cast
export const FISH_MS: [number, number] = [5000, 18000];  // bobber wait
export const CRAFT_PAD_MS = 500;                         // between crafts

// ---------------------------------------------------------------- events

export type SimEvent =
  | { t: number; type: 'spawn'; mob: Mob }
  | { t: number; type: 'swing'; who: 'player' | 'mob'; result: 'hit' | 'crit' | 'miss' | 'dodge'; dmg: number }
  | { t: number; type: 'kill'; creature: number; xp: number; gold: number; items: [number, number][] }
  | { t: number; type: 'death' }
  | { t: number; type: 'revive' }
  | { t: number; type: 'levelup'; level: number }
  | { t: number; type: 'skillup'; skill: Profession; level: number }
  | { t: number; type: 'harvest'; skill: Profession; items: [number, number][] }
  | { t: number; type: 'escape' } // a fish got away
  | { t: number; type: 'eat'; item: number }
  | { t: number; type: 'stop'; reason: string };

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
  maxHp: number; ap: number; armor: number;
  dmgMin: number; dmgMax: number; speedMs: number;
  crit: number; dodge: number; regenPerSec: number;
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
  armor += agi * 2;
  const baseHp = data.classStats[cls]?.[level]?.[0] ?? 20;
  const ap = meleeAttackPower(cls, level, str, agi);
  const weapon = s.equipment.mainhand ? data.items[s.equipment.mainhand] : undefined;
  const speedMs = weapon?.delayMs || 2000;
  const bonus = (ap / 14) * (speedMs / 1000);
  return {
    str, agi, sta, int: int_, spi, armor, ap, speedMs,
    maxHp: baseHp + healthFromStamina(sta),
    dmgMin: Math.max(1, Math.round((weapon?.dmgMin || 1) + bonus)),
    dmgMax: Math.max(1, Math.round((weapon?.dmgMax || 2) + bonus)),
    crit: Math.min(50, 5 + agi / 20),
    dodge: Math.min(30, agi / 20),
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
    case 'combat': return Math.min(ph.playerSwingAt, ph.mobSwingAt);
    case 'rest': {
      const st = playerStats(s, data);
      if (s.char.hp >= st.maxHp) return s.now;
      const eat = ph.eating;
      if (eat && eat.until <= s.now) return s.now; // finished eating: decide whether to eat again
      // Walk regen ticks until full or until the meal ends. Every tick heals >= 1, so this terminates.
      let hp = s.char.hp;
      for (let tick = tickAfter(s.now); ; tick += REGEN_TICK_MS) {
        if (eat && eat.until < tick) return eat.until;
        hp += regenPerTick(st) + (eat ? eat.perTick : 0);
        if (hp >= st.maxHp) return tick;
      }
    }
  }
}

/**
 * Health regenerates in whole points on 2-second ticks aligned to absolute time, while not in
 * combat and not dead. Aligned integer ticks make the result independent of how time is chunked.
 */
export const REGEN_TICK_MS = 2000;
const tickAfter = (t: number) => (Math.floor(t / REGEN_TICK_MS) + 1) * REGEN_TICK_MS;
const ticksBetween = (from: number, to: number) => Math.max(0, Math.floor(to / REGEN_TICK_MS) - Math.floor(from / REGEN_TICK_MS));
const regenPerTick = (st: PlayerStats) => Math.max(1, Math.round(st.regenPerSec * REGEN_TICK_MS / 1000));

function regen(s: GameState, data: GameData, to: number): void {
  const ph = s.phase;
  if (to <= s.now || ph.p === 'combat' || ph.p === 'dead') return;
  const ticks = ticksBetween(s.now, to);
  if (!ticks) return;
  const st = playerStats(s, data);
  let gain = ticks * regenPerTick(st);
  if (ph.p === 'rest' && ph.eating) gain += ticksBetween(s.now, Math.min(to, ph.eating.until)) * ph.eating.perTick;
  s.char.hp = Math.min(st.maxHp, s.char.hp + gain);
}

function step(s: GameState, data: GameData, emit: Emit): void {
  const a = s.action;
  if (!a) { s.phase = { p: 'idle' }; return; }
  switch (a.kind) {
    case 'fight': return stepFight(s, data, a.creature, emit);
    case 'gather': return stepGather(s, data, a.node, emit);
    case 'fish': return stepFish(s, data, emit);
    case 'cook': return stepCook(s, data, a.recipe, emit);
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
    s.phase = { p: 'combat', mob, playerSwingAt: s.now + 300, mobSwingAt: s.now + 800 };
    emit({ t: s.now, type: 'spawn', mob: { ...mob } });
    return;
  }
  if (ph.p === 'dead') {
    s.char.hp = Math.ceil(st.maxHp * 0.5);
    log(s, 'info', 'You return to your corpse and resurrect.');
    emit({ t: s.now, type: 'revive' });
    return startRest(s, data, emit);
  }
  if (ph.p === 'rest') {
    if (s.char.hp >= st.maxHp) {
      s.phase = { p: 'search', from: s.now, until: s.now + int(s.rng, ...SEARCH_MS) };
    } else if (ph.eating && s.now >= ph.eating.until) {
      ph.eating = undefined; // finished eating; keep resting on base regen (or eat again)
      maybeEat(s, data, emit);
    }
    return;
  }
  if (ph.p !== 'combat') { s.phase = { p: 'idle' }; return; }

  const mob = ph.mob;
  const stats = def.stats[mob.level - def.levelMin];
  if (ph.playerSwingAt <= ph.mobSwingAt) {
    // player swing
    const r = s.rng;
    let result: 'hit' | 'crit' | 'miss' | 'dodge', dmg = 0;
    const miss = missChance(s.char.level * 5, mob.level * 5);
    const roll = int(r, 0, 9999) / 100;
    if (roll < miss) result = 'miss';
    else if (roll < miss + 5 + (mob.level - s.char.level) * 0.1) result = 'dodge';
    else {
      dmg = int(r, st.dmgMin, st.dmgMax);
      result = chance(r, st.crit) ? 'crit' : 'hit';
      if (result === 'crit') dmg *= 2;
      dmg = Math.max(1, Math.round(dmg * (1 - armorReduction(stats.armor, s.char.level))));
    }
    mob.hp -= dmg;
    ph.playerSwingAt = s.now + st.speedMs;
    emit({ t: s.now, type: 'swing', who: 'player', result, dmg });
    if (mob.hp <= 0) return onKill(s, data, def, mob, emit);
  } else {
    // mob swing
    const r = s.rng;
    let result: 'hit' | 'crit' | 'miss' | 'dodge', dmg = 0;
    const miss = missChance(mob.level * 5, s.char.level * 5);
    const roll = int(r, 0, 9999) / 100;
    if (roll < miss) result = 'miss';
    else if (roll < miss + st.dodge) result = 'dodge';
    else {
      dmg = int(r, stats.dmgMin, stats.dmgMax);
      result = chance(r, 5) ? 'crit' : 'hit';
      if (result === 'crit') dmg *= 2;
      dmg = Math.max(1, Math.round(dmg * (1 - armorReduction(st.armor, mob.level))));
    }
    s.char.hp -= dmg;
    ph.mobSwingAt = s.now + def.attackMs;
    emit({ t: s.now, type: 'swing', who: 'mob', result, dmg });
    if (s.char.hp <= 0) {
      s.char.hp = 0;
      s.stats.deaths++;
      log(s, 'death', `You were slain by ${def.name}.`);
      emit({ t: s.now, type: 'death' });
      s.phase = { p: 'dead', from: s.now, until: s.now + DEATH_MS };
    }
  }
}

function onKill(s: GameState, data: GameData, def: CreatureDef, mob: Mob, emit: Emit): void {
  const xp = s.char.level < data.maxLevel ? killXp(s.char.level, mob.level, def.rank) : 0;
  const gold = def.goldMax ? int(s.rng, def.goldMin, def.goldMax) : 0;
  const drops = rollLoot(def.loot, s.rng);
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
  if (s.char.hp >= st.maxHp * s.settings.eatBelowPct / 100) return;
  const missing = st.maxHp - s.char.hp;
  const foods = Object.keys(s.inventory).map(Number).map(id => data.items[id])
    .filter((it): it is ItemDef => !!it?.food?.heal && it.reqLevel <= s.char.level)
    .sort((a, b) => a.food!.heal - b.food!.heal);
  if (!foods.length) return;
  const pick = foods.find(f => f.food!.heal >= missing) ?? foods[foods.length - 1];
  addItem(s, pick.id, -1);
  const ticks = Math.max(1, Math.round(pick.food!.durationMs / REGEN_TICK_MS));
  ph.eating = { item: pick.id, perTick: Math.max(1, Math.round(pick.food!.heal / ticks)), until: s.now + pick.food!.durationMs };
  emit({ t: s.now, type: 'eat', item: pick.id });
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
  const drops = rollLoot(node.loot, s.rng);
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
    const drops = rollLoot(zone.fishing.loot, s.rng);
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
  return null;
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
    : canCook(s, data, action.recipe);
  if (err) return fail(err);
  if (s.phase.p === 'dead') return fail('You are dead. Wait to resurrect.');
  s.action = action;
  if (s.phase.p !== 'rest') s.phase = { p: 'idle' };
  return ok;
}

export function stopAction(s: GameState): CommandResult {
  if (s.phase.p === 'dead') return fail('You are dead. Wait to resurrect.');
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
  if (!zone?.vendorItems.some(v => v.item === item)) return fail('No vendor here sells that.');
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

export function equip(s: GameState, data: GameData, item: number): CommandResult {
  const it = data.items[item];
  if (!it || !hasItem(s, item)) return fail("You don't have that.");
  const slots = equipSlots(it);
  if (!slots.length) return fail("You can't equip that.");
  if (it.reqLevel > s.char.level) return fail(`Requires level ${it.reqLevel}.`);
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
