// Class combat: real spells with an automatic rotation. Every decision and roll is a discrete event
// drawn from the state's RNG, so fights stay deterministic (server simulates, client replays).
import type { CreatureDef, GameData } from './data.js';
import { armorReduction, missChance } from './formulas.js';
import { chance, int } from './rng.js';
import { scaled, type SpellDef, type SpellEffect } from './spells.js';
import { spellMods, type TalentEffect } from './talents.js';
import type { GameState, Mob } from './state.js';
import { DEADLY_CHANCE, DEADLY_MS, DEADLY_STACKS, INSTANT_CHANCE, type Poisons } from './classes.js';

/** Spell ids shown for poison damage (Instant Poison VI, Deadly Poison V). */
export const POISON_INSTANT = 11338, POISON_DEADLY = 11357;

export const GCD_DEFAULT_MS = 1500;
export const POWER_TICK_MS = 2000;
export const FIVE_SECOND_RULE_MS = 5000;
export const RAGE_MAX = 1000;      // rage is stored in tenths, like spell costs (Heroic Strike = 150)
export const ENERGY_MAX = 100;
export const ENERGY_PER_TICK = 20;
export const PROC_WINDOW_MS = 5000; // Overpower / Revenge stay usable this long after the trigger
const HEAL_BELOW = 0.45;
const NEXT_SWING_RAGE_RESERVE = 150;

// ---------------------------------------------------------------- what you know

/** Highest known rank of each spell chain the character can use at its level. */
export function knownSpells(s: GameState, data: GameData): SpellDef[] {
  const best = new Map<number, SpellDef>();
  for (const id of s.spells ?? []) {
    const sp = data.spells?.[id];
    if (!sp || sp.spellLevel > s.char.level) continue;
    const cur = best.get(sp.chain);
    if (!cur || sp.spellLevel > cur.spellLevel || (sp.spellLevel === cur.spellLevel && sp.id > cur.id)) best.set(sp.chain, sp);
  }
  return [...best.values()];
}

export interface Passives {
  str: number; agi: number; sta: number; int: number; spi: number;
  ap: number; rap: number; armor: number; hastePct: number; thorns: number; seal: number;
}

const passiveCache = new Map<string, Passives>();
/** Always-on effects of known buffs, seals and shields (rebuffing is out-of-combat busywork). */
export function passives(s: GameState, data: GameData): Passives {
  const key = `${s.char.cls}:${s.char.level}:${(s.spells ?? []).join(',')}`;
  const hit = passiveCache.get(key);
  if (hit) return hit;
  const p: Passives = { str: 0, agi: 0, sta: 0, int: 0, spi: 0, ap: 0, rap: 0, armor: 0, hastePct: 0, thorns: 0, seal: 0 };
  // Only one seal and one armor-type self buff per family is active in the game; take the best of each.
  let bestSeal = 0;
  for (const sp of knownSpells(s, data)) {
    for (const e of sp.effects) {
      const v = (base: number, per: number) => scaled(base, per, sp, s.char.level);
      if (e.k === 'buff') {
        const amt = v(e.amount, e.perLevel);
        if (e.stat === 'all') { p.str += amt; p.agi += amt; p.sta += amt; p.int += amt; p.spi += amt; }
        else if (e.stat === 'haste') p.hastePct += amt;
        else p[e.stat] += amt;
      } else if (e.k === 'thorns') p.thorns = Math.max(p.thorns, v(e.amount, e.perLevel));
      else if (e.k === 'seal') bestSeal = Math.max(bestSeal, v(e.amount, e.perLevel));
    }
  }
  p.seal = bestSeal;
  if (passiveCache.size > 500) passiveCache.clear();
  passiveCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------- power

export function usesMana(s: GameState, data: GameData): boolean {
  return (data.classStats[s.char.cls]?.[s.char.level]?.[1] ?? 0) > 0;
}

export function maxMana(s: GameState, data: GameData, int: number): number {
  const base = data.classStats[s.char.cls]?.[s.char.level]?.[1] ?? 0;
  if (!base) return 0;
  return base + (int <= 20 ? int : 20 + (int - 20) * 15);
}

/** Mana per 2 s tick outside the five-second rule (vanilla spirit regen, per class). */
export function manaPerTick(cls: number, spi: number): number {
  switch (cls) {
    case 5: case 8: return Math.round(12.5 + spi / 4);  // priest, mage
    case 9: return Math.round(8 + spi / 4);            // warlock
    default: return Math.round(15 + spi / 5);          // druid, shaman, paladin, hunter
  }
}

const ticks = (from: number, to: number) => Math.max(0, Math.floor(to / POWER_TICK_MS) - Math.floor(from / POWER_TICK_MS));

/** Brings mana and energy up to `now` on aligned 2 s ticks (chunk-independent). */
export function syncPower(s: GameState, data: GameData, now: number, spi: number, int: number): void {
  const c = s.char;
  const from = c.powerAt ?? now;
  if (now <= from) { c.powerAt = Math.max(from, now); return; }
  if (usesMana(s, data)) {
    const regenFrom = Math.max(from, (c.lastCastAt ?? -Infinity) + FIVE_SECOND_RULE_MS);
    const n = ticks(regenFrom, now);
    if (n) c.mana = Math.min(maxMana(s, data, int), (c.mana ?? 0) + n * manaPerTick(c.cls, spi));
  }
  if (c.cls === 4) c.energy = Math.min(ENERGY_MAX, (c.energy ?? ENERGY_MAX) + ticks(from, now) * ENERGY_PER_TICK);
  c.powerAt = now;
}

export function powerOf(s: GameState, sp: SpellDef): number {
  switch (sp.power) {
    case 'rage': return s.char.rage ?? 0;
    case 'energy': return s.char.energy ?? 0;
    case 'health': return Infinity;
    default: return s.char.mana ?? 0;
  }
}

function spend(s: GameState, sp: SpellDef, cost = sp.cost): void {
  if (!cost) return;
  if (sp.power === 'rage') s.char.rage = Math.max(0, (s.char.rage ?? 0) - cost);
  else if (sp.power === 'energy') s.char.energy = Math.max(0, (s.char.energy ?? 0) - cost);
  else if (sp.power === 'mana') s.char.mana = Math.max(0, (s.char.mana ?? 0) - cost);
}

/** A spell as your talents change it: cast time, cost, cooldown, damage and crit. */
export interface Modded { castMs: number; cost: number; cooldownMs: number; dmgMult: number; dmgFlat: number; critBonus: number }
export function modded(sp: SpellDef, talents: TalentEffect[]): Modded {
  const m = spellMods(talents, sp);
  return {
    castMs: Math.max(0, Math.round((sp.castMs + m.castTime.flat) * (1 + m.castTime.pct / 100))),
    cost: Math.max(0, Math.round((sp.cost + m.cost.flat) * (1 + m.cost.pct / 100))),
    cooldownMs: Math.max(0, Math.round((sp.cooldownMs + m.cooldown.flat) * (1 + m.cooldown.pct / 100))),
    dmgMult: 1 + m.damage.pct / 100, dmgFlat: m.damage.flat, critBonus: m.crit.flat,
  };
}

/** Rage from dealing (7.5x) or taking (2.5x) damage, vanilla formula. */
export function rageFrom(dmg: number, level: number, dealt: boolean): number {
  const c = 0.0091107836 * level * level + 3.225598133 * level + 4.2652911;
  return Math.round((dealt ? 7.5 : 2.5) * dmg / c * 10);
}

// ---------------------------------------------------------------- the fight

export interface Dot { chain: number; perTick: number; ampMs: number; next: number; until: number; heal?: boolean; channel?: boolean;
  base?: number; dice?: number; spell?: number }

export interface CombatPhase {
  p: 'combat'; mob: Mob; playerSwingAt: number; mobSwingAt: number;
  decideAt?: number; gcdUntil?: number; casting?: { spell: number; until: number };
  cooldowns?: Record<number, number>; queued?: number; combo?: number;
  dots?: Dot[]; shield?: number; targetDodgedAt?: number; selfAvoidedAt?: number;
  mobApMod?: number; mobHastePct?: number;
  /** Your pet: its health this fight and its next swing. */
  petHp?: number; petSwingAt?: number; petSpecialAt?: number;
  /** Hunters get a few shots in from range before the mob reaches them (when no pet holds it). */
  openUntil?: number;
}

export interface CombatCtx {
  data: GameData; def: CreatureDef;
  st: { dmgMin: number; dmgMax: number; speedMs: number; crit: number; spellCrit: number; meleeHit: number; spellHit: number; ap: number; int: number; spi: number; level: number; maxHp: number };
  talents: TalentEffect[];
  emitSwing(who: 'player' | 'mob' | 'pet', result: 'hit' | 'crit' | 'miss' | 'dodge', dmg: number, spell?: number): void;
  /** Shooting from range (hunters with a ranged weapon and ammo): st holds the ranged weapon's numbers. */
  ranged?: boolean;
  useAmmo?(): void;
  /** Shooting a wand: magic damage, no armor. */
  wand?: boolean;
  /** A rogue's weapon poisons. */
  poisons?: Poisons;
  /** Your pet's attack, while it lives. */
  pet?: { dmgMin: number; dmgMax: number; speedMs: number; ignoresArmor: boolean; special?: { everyMs: number; mult: number } };
  emitHeal(amount: number, spell: number): void;
  raiseWeaponSkill(): number; // returns the current weapon skill value
}

/** Next time something happens in this fight. */
export function combatNextAt(ph: CombatPhase): number {
  let t = Math.min(ph.mobSwingAt, ph.casting ? ph.casting.until : ph.playerSwingAt, ph.decideAt ?? Infinity);
  if ((ph.petHp ?? 0) > 0 && ph.petSwingAt !== undefined) t = Math.min(t, ph.petSwingAt);
  for (const d of ph.dots ?? []) t = Math.min(t, d.next);
  return t;
}

/**
 * Resolves the earliest event in the fight. Returns 'killed' when the mob died (the caller loots),
 * 'continue' otherwise. Mob swings are left to the caller (they share the death logic).
 */
export function combatStep(s: GameState, ph: CombatPhase, ctx: CombatCtx): 'killed' | 'mob-swing' | 'continue' {
  const now = s.now;
  const dot = (ph.dots ?? []).filter(d => d.next <= now).sort((a, b) => a.next - b.next)[0];
  const swingAt = ph.casting ? Infinity : ph.playerSwingAt;
  const petAt = (ph.petHp ?? 0) > 0 && ctx.pet ? ph.petSwingAt ?? Infinity : Infinity;
  const first = Math.min(ph.casting?.until ?? Infinity, dot?.next ?? Infinity, swingAt, ph.mobSwingAt, ph.decideAt ?? Infinity, petAt);

  if (petAt === first && petAt < ph.mobSwingAt) {
    petSwing(s, ph, ctx);
    return ph.mob.hp <= 0 ? 'killed' : 'continue';
  }

  if (ph.casting && ph.casting.until === first) {
    const sp = ctx.data.spells[ph.casting.spell];
    ph.casting = undefined;
    ph.playerSwingAt = Math.max(ph.playerSwingAt, now); // the swing timer waits while casting
    if (sp && !sp.effects.some(e => e.k === 'channel')) castLand(s, ph, ctx, sp);
    ph.decideAt = now;
    return ph.mob.hp <= 0 ? 'killed' : 'continue';
  }
  if (dot && dot.next === first) {
    if (dot.heal) {
      const amt = dot.perTick;
      s.char.hp = Math.min(ctx.st.maxHp, s.char.hp + amt);
      ctx.emitHeal(amt, dot.spell ?? 0);
    } else {
      const dmg = dot.channel ? (dot.base ?? 0) + int(s.rng, 0, dot.dice ?? 0) : dot.perTick;
      ph.mob.hp -= dmg;
      ctx.emitSwing('player', 'hit', dmg, dot.spell);
    }
    dot.next += dot.ampMs;
    if (dot.next > dot.until) ph.dots = (ph.dots ?? []).filter(d => d !== dot);
    return ph.mob.hp <= 0 ? 'killed' : 'continue';
  }
  if (swingAt === first && swingAt <= ph.mobSwingAt) {
    playerSwing(s, ph, ctx);
    ph.decideAt = Math.min(ph.decideAt ?? Infinity, now); // rage, procs and combo points may have changed
    return ph.mob.hp <= 0 ? 'killed' : 'continue';
  }
  if (ph.mobSwingAt === first) return 'mob-swing';
  // Rotation decision.
  ph.decideAt = undefined;
  decide(s, ph, ctx);
  return ph.mob.hp <= 0 ? 'killed' : 'continue';
}

function petSwing(s: GameState, ph: CombatPhase, ctx: CombatCtx): void {
  const pet = ctx.pet!, mob = ph.mob;
  ph.petSwingAt = s.now + pet.speedMs;
  const roll = int(s.rng, 0, 9999) / 100;
  if (roll < 5) { ctx.emitSwing('pet', 'miss', 0); return; }
  if (roll < 10 && !pet.ignoresArmor) { ctx.emitSwing('pet', 'dodge', 0); return; }
  const crit = roll >= 95;
  // Bite / Claw / Lash of Pain when it's ready.
  const special = pet.special && s.now >= (ph.petSpecialAt ?? 0);
  if (special) ph.petSpecialAt = s.now + pet.special!.everyMs;
  let dmg = int(s.rng, pet.dmgMin, pet.dmgMax) * (crit ? 2 : 1) * (special ? pet.special!.mult : 1);
  if (!pet.ignoresArmor) dmg = dmg * (1 - armorReduction(ctx.def.stats[mob.level - ctx.def.levelMin].armor, ctx.st.level));
  dmg = Math.max(1, Math.round(dmg));
  mob.hp -= dmg;
  ctx.emitSwing('pet', crit ? 'crit' : 'hit', dmg);
}

function playerSwing(s: GameState, ph: CombatPhase, ctx: CombatCtx): void {
  const mob = ph.mob, { st, def } = ctx;
  const skill = ctx.raiseWeaponSkill();
  // A queued melee attack (Raptor Strike) waits while you shoot.
  const wanted = ph.queued !== undefined && !ctx.ranged ? ctx.data.spells[ph.queued] : undefined;
  if (!ctx.ranged) ph.queued = undefined;
  if (ctx.ranged) ctx.useAmmo?.();
  // A queued next-swing attack only happens if you can still pay for it; otherwise it's a plain swing.
  const queued = wanted && powerOf(s, wanted) >= wanted.cost ? wanted : undefined;
  if (queued) spend(s, queued);
  const p = passives(s, ctx.data);
  ph.playerSwingAt = s.now + Math.round(st.speedMs / (1 + p.hastePct / 100));
  const miss = Math.max(0, missChance(skill, mob.level * 5) - st.meleeHit);
  const roll = int(s.rng, 0, 9999) / 100;
  if (roll < miss) { ctx.emitSwing('player', 'miss', 0, queued?.id); return; }
  if (roll < miss + Math.max(0, 5 + (mob.level * 5 - skill) * 0.1)) {
    ph.targetDodgedAt = s.now;
    ctx.emitSwing('player', 'dodge', 0, queued?.id);
    return;
  }
  let dmg = int(s.rng, st.dmgMin, st.dmgMax);
  if (queued) for (const e of queued.effects) if (e.k === 'weapon') dmg = Math.round(dmg * (e.pct ? e.pct / 100 : 1) + e.flat);
  const crit = chance(s.rng, st.crit);
  if (crit) dmg *= 2;
  const stats = def.stats[mob.level - def.levelMin];
  dmg = Math.max(1, Math.round(dmg * (ctx.wand ? 1 : 1 - armorReduction(stats.armor, st.level))));
  if (p.seal) dmg += Math.round(p.seal / 100 * (st.speedMs / 1000)); // seal of righteousness: holy damage per swing
  mob.hp -= dmg;
  if (s.char.cls === 1) s.char.rage = Math.min(RAGE_MAX, (s.char.rage ?? 0) + rageFrom(dmg, st.level, true));
  ctx.emitSwing('player', crit ? 'crit' : 'hit', dmg, queued?.id);
  if (!ctx.ranged) applyPoisons(s, ph, ctx);
}

/** Weapon poisons: Instant Poison strikes for nature damage, Deadly Poison stacks a damage over time. */
function applyPoisons(s: GameState, ph: CombatPhase, ctx: CombatCtx): void {
  const p = ctx.poisons;
  if (!p || ph.mob.hp <= 0) return;
  if (p.instant && chance(s.rng, INSTANT_CHANCE)) {
    const dmg = int(s.rng, p.instant.min, p.instant.max);
    ph.mob.hp -= dmg;
    ctx.emitSwing('player', 'hit', dmg, POISON_INSTANT);
  }
  if (p.deadly && chance(s.rng, DEADLY_CHANCE)) {
    const dots = (ph.dots ??= []);
    const cur = dots.find(d => d.chain === POISON_DEADLY);
    const stacks = Math.min(DEADLY_STACKS, (cur ? Math.round(cur.perTick / (p.deadly.perStack / 4)) : 0) + 1);
    const perTick = Math.round(p.deadly.perStack / 4 * stacks);
    if (cur) { cur.perTick = perTick; cur.until = s.now + DEADLY_MS; }
    else dots.push({ chain: POISON_DEADLY, perTick, ampMs: 3000, next: s.now + 3000, until: s.now + DEADLY_MS, spell: POISON_DEADLY });
  }
}

/** Expected damage of a spell (for choosing), without rolling. */
function expected(s: GameState, ph: CombatPhase, ctx: CombatCtx, sp: SpellDef): number {
  let total = 0;
  const lvl = ctx.st.level;
  for (const e of sp.effects) {
    if (e.k === 'damage') total += scaled(e.base + e.dice / 2, e.perLevel, sp, lvl) + e.perCombo * (ph.combo ?? 0);
    else if (e.k === 'weapon') total += ((ctx.st.dmgMin + ctx.st.dmgMax) / 2) * (e.pct ? e.pct / 100 : 1) + e.flat;
    else if (e.k === 'dot') total += e.perTick * Math.floor(sp.durationMs / e.ampMs);
    else if (e.k === 'channel') total += scaled(e.base + e.dice / 2, e.perLevel, sp, lvl) * Math.floor(sp.durationMs / e.ampMs);
  }
  const md = modded(sp, ctx.talents);
  return total * md.dmgMult + (total > 0 ? md.dmgFlat : 0);
}

function usable(s: GameState, ph: CombatPhase, ctx: CombatCtx, sp: SpellDef): boolean {
  // Shots need a ranged weapon and ammo; melee specials need the mob in melee range.
  if (sp.dmgClass === 3 && !ctx.ranged) return false;
  if (ctx.ranged && (sp.dmgClass === 2 || sp.nextSwing)) return false;
  if (sp.effects.every(e => e.k === 'buff' || e.k === 'thorns' || e.k === 'seal' || e.k === 'conjure')) return false;
  if ((ph.cooldowns?.[sp.chain] ?? 0) > s.now) return false;
  if (powerOf(s, sp) < modded(sp, ctx.talents).cost) return false;
  if (sp.requires === 'target-dodged' && !(ph.targetDodgedAt !== undefined && s.now - ph.targetDodgedAt <= PROC_WINDOW_MS)) return false;
  if (sp.requires === 'self-avoided' && !(ph.selfAvoidedAt !== undefined && s.now - ph.selfAvoidedAt <= PROC_WINDOW_MS)) return false;
  if (sp.requires === 'target-below-20' && ph.mob.hp > ph.mob.maxHp * 0.2) return false;
  return true;
}

function decide(s: GameState, ph: CombatPhase, ctx: CombatCtx): void {
  if (ph.casting) return;
  if ((ph.gcdUntil ?? 0) > s.now) { ph.decideAt = ph.gcdUntil; return; }
  const spells = knownSpells(s, ctx.data).filter(sp => usable(s, ph, ctx, sp));
  const hpFrac = s.char.hp / ctx.st.maxHp;

  // Next-swing attacks (Heroic Strike, Raptor Strike) don't use the GCD: queue one when there's spare power.
  if (ph.queued === undefined && !ctx.ranged) {
    const ns = spells.filter(sp => sp.nextSwing).sort((a, b) => expected(s, ph, ctx, b) - expected(s, ph, ctx, a))[0];
    if (ns && powerOf(s, ns) >= ns.cost + (ns.power === 'rage' ? NEXT_SWING_RAGE_RESERVE : 0)) ph.queued = ns.id;
  }

  let best: SpellDef | undefined, bestScore = 0;
  const healCost = Math.min(...spells.filter(sp => sp.effects.some(e => e.k === 'heal')).map(sp => sp.cost), Infinity);
  for (const sp of spells) {
    if (sp.nextSwing) continue;
    const time = Math.max(modded(sp, ctx.talents).castMs, sp.gcdMs || GCD_DEFAULT_MS) / 1000;
    let score = 0;
    for (const e of sp.effects) {
      if ((e.k === 'heal' || e.k === 'hot') && hpFrac < HEAL_BELOW) {
        const amount = e.k === 'heal' ? scaled(e.base + e.dice / 2, e.perLevel, sp, ctx.st.level) : e.perTick * Math.floor(sp.durationMs / e.ampMs);
        const hotActive = e.k === 'hot' && (ph.dots ?? []).some(d => d.heal && d.chain === sp.chain);
        if (!hotActive) score = Math.max(score, 1000 + amount / time);
      } else if (e.k === 'shield' && !ph.shield && hpFrac < 0.7) score = Math.max(score, 900);
      else if (e.k === 'energize' && s.char.cls === 1 && (s.char.rage ?? 0) < 200) score = Math.max(score, 400); // Charge, Bloodrage
    }
    const dmg = expected(s, ph, ctx, sp);
    if (dmg > 0) {
      const isDot = sp.effects.some(e => e.k === 'dot');
      const dotActive = isDot && (ph.dots ?? []).some(d => !d.heal && d.chain === sp.chain);
      const isFinisher = sp.effects.some(e => e.k === 'damage' && e.perCombo > 0);
      if (dotActive && !sp.effects.some(e => e.k === 'damage')) continue;
      if (isFinisher && (ph.combo ?? 0) < 5 && ph.mob.hp > dmg) continue;
      if (isDot && ph.mob.hp < dmg * 0.5 && !sp.effects.some(e => e.k === 'damage')) continue; // won't live long enough
      // Mana users keep enough for a heal in reserve.
      if (sp.power === 'mana' && healCost < Infinity && (s.char.mana ?? 0) - sp.cost < healCost && !sp.effects.some(e => e.k === 'heal')) continue;
      score = Math.max(score, dmg / time);
    }
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  if (!best) {
    // Nothing to do yet: look again at the next power tick (or when a swing changes rage/combo/procs).
    ph.decideAt = (Math.floor(s.now / POWER_TICK_MS) + 1) * POWER_TICK_MS;
    return;
  }
  cast(s, ph, ctx, best);
}

function cast(s: GameState, ph: CombatPhase, ctx: CombatCtx, sp: SpellDef): void {
  const md = modded(sp, ctx.talents);
  spend(s, sp, md.cost);
  if (sp.power === 'mana') s.char.lastCastAt = s.now;
  if (md.cooldownMs) (ph.cooldowns ??= {})[sp.chain] = s.now + md.cooldownMs;
  ph.gcdUntil = s.now + (sp.gcdMs || GCD_DEFAULT_MS);
  const channel = sp.effects.find((e): e is SpellEffect & { k: 'channel' } => e.k === 'channel');
  if (md.castMs > 0) {
    ph.casting = { spell: sp.id, until: s.now + md.castMs };
    if (channel) {
      (ph.dots ??= []).push({ chain: sp.chain, perTick: 0, ampMs: channel.ampMs, next: s.now + channel.ampMs, until: s.now + sp.castMs,
        channel: true, base: scaled(channel.base, channel.perLevel, sp, ctx.st.level), dice: channel.dice, spell: sp.id });
    }
    return;
  }
  castLand(s, ph, ctx, sp);
  ph.decideAt = ph.gcdUntil;
}

/** A spell lands: roll hit/crit and apply its effects. */
function castLand(s: GameState, ph: CombatPhase, ctx: CombatCtx, sp: SpellDef): void {
  const mob = ph.mob, lvl = ctx.st.level;
  const harmful = sp.effects.some(e => e.k === 'damage' || e.k === 'weapon' || e.k === 'dot' || e.k === 'debuff');
  if (harmful) {
    const melee = sp.dmgClass === 2 || sp.dmgClass === 3; // shots roll like weapon attacks
    const diff = Math.max(0, mob.level - lvl);
    const miss = Math.max(melee ? 0 : 1, melee
      ? missChance(lvl * 5, mob.level * 5) - ctx.st.meleeHit
      : Math.min(40, 4 + diff + (diff > 2 ? (diff - 2) * 10 : 0)) - ctx.st.spellHit);
    if (chance(s.rng, miss)) { ctx.emitSwing('player', 'miss', 0, sp.id); return; } // the cost is still spent
  }
  const md = modded(sp, ctx.talents);
  const physical = sp.dmgClass === 2 || sp.dmgClass === 3;
  const critChance = (physical ? ctx.st.crit : ctx.st.spellCrit) + md.critBonus;
  const crit = chance(s.rng, critChance);
  let dealt = 0;
  for (const e of sp.effects) {
    switch (e.k) {
      case 'damage': {
        let v = scaled(e.base, e.perLevel, sp, lvl) + int(s.rng, 0, e.dice) + e.perCombo * (ph.combo ?? 0);
        if (e.perCombo) ph.combo = 0;
        if (sp.school === 0) v = Math.round(v * (1 - armorReduction(ctx.def.stats[mob.level - ctx.def.levelMin].armor, lvl)));
        dealt += Math.round((v * md.dmgMult + md.dmgFlat) * (crit ? (physical ? 2 : 1.5) : 1));
        break;
      }
      case 'weapon': {
        let v = int(s.rng, ctx.st.dmgMin, ctx.st.dmgMax) * (e.pct ? e.pct / 100 : 1) + e.flat;
        v = v * (1 - armorReduction(ctx.def.stats[mob.level - ctx.def.levelMin].armor, lvl));
        dealt += Math.round((v * md.dmgMult + md.dmgFlat) * (crit ? 2 : 1));
        break;
      }
      case 'dot':
        ph.dots = (ph.dots ?? []).filter(d => d.heal || d.chain !== sp.chain);
        ph.dots.push({ chain: sp.chain, perTick: e.perTick, ampMs: e.ampMs, next: s.now + e.ampMs, until: s.now + sp.durationMs, spell: sp.id });
        break;
      case 'hot':
        ph.dots = (ph.dots ?? []).filter(d => !d.heal || d.chain !== sp.chain);
        ph.dots.push({ chain: sp.chain, perTick: e.perTick, ampMs: e.ampMs, next: s.now + e.ampMs, until: s.now + sp.durationMs, heal: true, spell: sp.id });
        break;
      case 'heal': {
        const amt = Math.round((scaled(e.base, e.perLevel, sp, lvl) + int(s.rng, 0, e.dice)) * (crit ? 1.5 : 1));
        s.char.hp = Math.min(ctx.st.maxHp, s.char.hp + amt);
        ctx.emitHeal(amt, sp.id);
        break;
      }
      case 'shield': ph.shield = Math.round(scaled(e.amount, e.perLevel, sp, lvl)); break;
      case 'combo': ph.combo = Math.min(5, (ph.combo ?? 0) + e.n); break;
      case 'energize':
        if (s.char.cls === 1) s.char.rage = Math.min(RAGE_MAX, (s.char.rage ?? 0) + e.amount);
        break;
      case 'debuff':
        if (e.stat === 'ap') ph.mobApMod = Math.min(ph.mobApMod ?? 0, scaled(e.amount, e.perLevel, sp, lvl));
        else ph.mobHastePct = Math.min(ph.mobHastePct ?? 0, e.amount);
        break;
    }
  }
  if (dealt > 0) {
    mob.hp -= dealt;
    if (s.char.cls === 1 && sp.power !== 'rage') s.char.rage = Math.min(RAGE_MAX, (s.char.rage ?? 0) + rageFrom(dealt, lvl, true));
    ctx.emitSwing('player', crit ? 'crit' : 'hit', dealt, sp.id);
  }
}

/** Mob attack modifiers from your debuffs: damage reduction (flat) and slower swings (ms). */
export function mobMods(ph: CombatPhase, attackMs: number): { dmgDelta: number; attackMs: number } {
  const dmgDelta = Math.round((ph.mobApMod ?? 0) / 14 * (attackMs / 1000));
  return { dmgDelta, attackMs: Math.round(attackMs * (1 - (ph.mobHastePct ?? 0) / 100)) };
}

/** Absorb shield soaks damage first. Returns the damage that gets through. */
export function absorb(ph: CombatPhase, dmg: number): number {
  if (!ph.shield) return dmg;
  const soaked = Math.min(ph.shield, dmg);
  ph.shield -= soaked;
  return dmg - soaked;
}
