// Profession specializations (vanilla): Armorsmith or Weaponsmith (and then a master of axes, hammers or
// swords), Dragonscale, Elemental or Tribal leatherworking, Gnomish or Goblin engineering. A specialization
// unlocks its own recipes; you pick one per choice, and switching gives up the old one's recipes.
import type { GameData } from './data.js';
import type { GameState, Profession } from './state.js';

export interface SpecDef { id: number; name: string; skill: Profession; reqSkill: number; reqLevel: number; cost: number; group: string; requires?: number }

export const SPECS: SpecDef[] = [
  { id: 9788, name: 'Armorsmith', skill: 'blacksmithing', reqSkill: 200, reqLevel: 40, cost: 50_000, group: 'smith' },
  { id: 9787, name: 'Weaponsmith', skill: 'blacksmithing', reqSkill: 200, reqLevel: 40, cost: 50_000, group: 'smith' },
  { id: 17039, name: 'Master Swordsmith', skill: 'blacksmithing', reqSkill: 250, reqLevel: 40, cost: 100_000, group: 'weapon', requires: 9787 },
  { id: 17040, name: 'Master Hammersmith', skill: 'blacksmithing', reqSkill: 250, reqLevel: 40, cost: 100_000, group: 'weapon', requires: 9787 },
  { id: 17041, name: 'Master Axesmith', skill: 'blacksmithing', reqSkill: 250, reqLevel: 40, cost: 100_000, group: 'weapon', requires: 9787 },
  { id: 10656, name: 'Dragonscale Leatherworking', skill: 'leatherworking', reqSkill: 225, reqLevel: 40, cost: 50_000, group: 'leather' },
  { id: 10658, name: 'Elemental Leatherworking', skill: 'leatherworking', reqSkill: 225, reqLevel: 40, cost: 50_000, group: 'leather' },
  { id: 10660, name: 'Tribal Leatherworking', skill: 'leatherworking', reqSkill: 225, reqLevel: 40, cost: 50_000, group: 'leather' },
  { id: 20219, name: 'Gnomish Engineering', skill: 'engineering', reqSkill: 200, reqLevel: 30, cost: 20_000, group: 'engineer' },
  { id: 20222, name: 'Goblin Engineering', skill: 'engineering', reqSkill: 200, reqLevel: 30, cost: 20_000, group: 'engineer' },
];
export const specById = (id: number) => SPECS.find(x => x.id === id);

/** Why you can't take this specialization (null: you can). */
export function specError(s: GameState, sp: SpecDef): string | null {
  if (s.specs?.includes(sp.id)) return 'You already have it.';
  const sk = s.skills[sp.skill];
  if (!sk?.max) return `Learn ${sp.skill} first.`;
  if (s.char.level < sp.reqLevel) return `Requires level ${sp.reqLevel}.`;
  if (sk.level < sp.reqSkill) return `Requires ${sp.reqSkill} skill.`;
  if (sp.requires && !s.specs?.includes(sp.requires)) return `Requires ${specById(sp.requires)?.name}.`;
  if (s.gold < sp.cost) return 'Not enough gold.';
  return null;
}

/** Take a specialization (replacing any other of the same choice, and the masteries that depended on it). */
export function specialize(s: GameState, data: GameData, id: number): { ok: true } | { ok: false; error: string } {
  const sp = specById(id);
  if (!sp) return { ok: false, error: 'Unknown specialization.' };
  const err = specError(s, sp);
  if (err) return { ok: false, error: err };
  s.gold -= sp.cost;
  const dropped = new Set((s.specs ?? []).filter(x => specById(x)?.group === sp.group));
  for (const x of [...dropped]) for (const y of SPECS) if (y.requires === x) dropped.add(y.id);
  s.specs = [...(s.specs ?? []).filter(x => !dropped.has(x)), id];
  // Recipes of a specialization you gave up are forgotten.
  s.recipes = s.recipes.filter(r => { const need = data.recipes[r]?.spec; return !need || s.specs!.includes(need); });
  return { ok: true };
}

/** Whether a recipe's specialization (if any) is yours. */
export const hasSpecFor = (s: GameState, spec?: number) => !spec || !!s.specs?.includes(spec);
