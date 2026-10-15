// Talents: the full 1.12 trees from Talent.dbc / TalentTab.dbc, with each rank's real effect.
// Effects that map onto the idle fight are applied; the rest are listed in DESIGN.md as "no effect yet".
import type { Copper, GameData } from './data.js';
import type { SpellDef } from './spells.js';
import type { GameState } from './state.js';
import { log } from './state.js';

export type TalentStat = 'str' | 'agi' | 'sta' | 'int' | 'spi';
export type SpellModOp = 'damage' | 'crit' | 'castTime' | 'cost' | 'cooldown';

export type TalentEffect =
  | { k: 'stat'; stat: TalentStat | 'all'; amount: number }
  | { k: 'statPct'; stat: TalentStat | 'all'; pct: number }
  | { k: 'healthPct'; pct: number }
  | { k: 'manaPct'; pct: number }
  | { k: 'meleeCrit'; pct: number }
  | { k: 'spellCrit'; pct: number }
  | { k: 'meleeHit'; pct: number }
  | { k: 'spellHit'; pct: number }
  | { k: 'dodge'; pct: number }
  | { k: 'armor'; amount: number }
  | { k: 'armorPct'; pct: number }
  | { k: 'ap'; amount: number }
  /** +pct damage for spells of these schools (bitmask: 1 physical, 2 holy, 4 fire, 8 nature, 16 frost, 32 shadow, 64 arcane). */
  | { k: 'schoolDamage'; schools: number; pct: number }
  /** Spell modifier for one class's spells selected by family flags (e.g. -0.5 s Fireball cast). */
  | { k: 'spellMod'; op: SpellModOp; flat: number; pct: number; family: number; mask: number };

export interface TalentDef {
  id: number; tab: number; row: number; col: number;
  /** Spell for each rank (index 0 = rank 1). */
  ranks: number[];
  requires?: { talent: number; rank: number };
  name: string; icon: string;
  /** Effects per rank (same indexing as ranks). */
  effects: TalentEffect[][];
  /** Tooltip-ish description of rank 1 (client text). */
  description: string;
}

export interface TalentTabDef { id: number; name: string; cls: number; order: number; icon: string; background: string }

export const POINTS_PER_ROW = 5;

export function talentPoints(level: number): number { return Math.max(0, level - 9); }

export function pointsSpent(s: GameState): number {
  return Object.values(s.talents ?? {}).reduce((a, b) => a + b, 0);
}

export function pointsInTab(s: GameState, data: GameData, tab: number): number {
  let n = 0;
  for (const [id, r] of Object.entries(s.talents ?? {})) if (data.talents?.[+id]?.tab === tab) n += r;
  return n;
}

export function canLearnTalent(s: GameState, data: GameData, id: number): string | null {
  const t = data.talents?.[id];
  if (!t) return 'Unknown talent.';
  const tab = data.talentTabs?.[t.tab];
  if (!tab || tab.cls !== s.char.cls) return "That isn't one of your talents.";
  const rank = s.talents?.[id] ?? 0;
  if (rank >= t.ranks.length) return 'Already at the highest rank.';
  if (pointsSpent(s) >= talentPoints(s.char.level)) return s.char.level < 10 ? 'Talents start at level 10.' : 'No talent points left.';
  if (pointsInTab(s, data, t.tab) < t.row * POINTS_PER_ROW) return `Requires ${t.row * POINTS_PER_ROW} points in ${tab.name}.`;
  if (t.requires && (s.talents?.[t.requires.talent] ?? 0) < t.requires.rank) {
    return `Requires ${t.requires.rank} point${t.requires.rank > 1 ? 's' : ''} in ${data.talents[t.requires.talent]?.name}.`;
  }
  return null;
}

export function learnTalent(s: GameState, data: GameData, id: number): { ok: true } | { ok: false; error: string } {
  const err = canLearnTalent(s, data, id);
  if (err) return { ok: false, error: err };
  (s.talents ??= {})[id] = (s.talents[id] ?? 0) + 1;
  return { ok: true };
}

/** Vanilla respec cost: 1g, then 5g, then +5g each time, capped at 50g. */
export function resetCost(s: GameState): Copper {
  const n = s.talentResets ?? 0;
  return n === 0 ? 10000 : Math.min(500000, n * 50000);
}

export function resetTalents(s: GameState): { ok: true } | { ok: false; error: string } {
  if (!pointsSpent(s)) return { ok: false, error: 'You have no talents to unlearn.' };
  const cost = resetCost(s);
  if (s.gold < cost) return { ok: false, error: `Unlearning costs ${Math.floor(cost / 10000)}g.` };
  s.gold -= cost;
  s.talents = {};
  s.talentResets = (s.talentResets ?? 0) + 1;
  log(s, 'info', 'Your talents have been reset.');
  return { ok: true };
}

/** All active talent effects of a character (the effects of each talent's current rank). */
export function activeTalentEffects(s: GameState, data: GameData): TalentEffect[] {
  const out: TalentEffect[] = [];
  for (const [id, rank] of Object.entries(s.talents ?? {})) {
    const t = data.talents?.[+id];
    if (t && rank > 0) out.push(...(t.effects[rank - 1] ?? []));
  }
  return out;
}

/** Combined spell modifiers that apply to `sp` (family + mask), by op. */
export function spellMods(effects: TalentEffect[], sp: SpellDef): Record<SpellModOp, { flat: number; pct: number }> {
  const m: Record<SpellModOp, { flat: number; pct: number }> = {
    damage: { flat: 0, pct: 0 }, crit: { flat: 0, pct: 0 }, castTime: { flat: 0, pct: 0 }, cost: { flat: 0, pct: 0 }, cooldown: { flat: 0, pct: 0 },
  };
  for (const e of effects) {
    if (e.k === 'spellMod' && e.family === sp.family && (sp.familyFlags & e.mask) !== 0) { m[e.op].flat += e.flat; m[e.op].pct += e.pct; }
    if (e.k === 'schoolDamage' && (e.schools & (1 << sp.school))) m.damage.pct += e.pct;
  }
  return m;
}
