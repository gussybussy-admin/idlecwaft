// Pets: a hunter's tamed beast and a warlock's demons. A pet fights on its own swing timer; tanking pets
// (beasts, the Voidwalker) also take the mob's attacks while they live, which is what lets a hunter stay at
// range. Pets are scaled from an ordinary mob of the owner's level, so they keep up as you level.
import type { CreatureDef, GameData } from './data.js';
import type { GameState } from './state.js';

export type PetKind = 'beast' | 'imp' | 'voidwalker' | 'succubus' | 'felhunter';

export interface Pet {
  kind: PetKind;
  name: string;
  /** The tamed creature (beasts), for its model. */
  creature?: number;
  displayId: number;
  /** Died in the last fight: it is revived (PET_REVIVE_MS) before the next one. Pets heal fully between fights. */
  dead?: boolean;
  /** Beasts: family (diet) and happiness (0-1000: below 333 unhappy, above 666 happy). */
  family?: number;
  happiness?: number;
  /** A warlock picked this demon (otherwise the best one known is summoned, and replaced as better ones are learned). */
  chosen?: boolean;
}

export interface PetStats { maxHp: number; armor: number; dmgMin: number; dmgMax: number; speedMs: number; tank: boolean }

export const HUNTER = 3, WARLOCK = 9;
/** Tame Beast: a level 10 hunter quest in vanilla. */
export const TAME_LEVEL = 10;
/** Reviving a dead pet before the next fight (Revive Pet / a new summon). */
export const PET_REVIVE_MS = 10_000;

/** Warlock demons: the level they're learned at, their model, and their strength next to a mob of your level. */
export const DEMONS: Record<Exclude<PetKind, 'beast'>, { level: number; name: string; displayId: number; hp: number; dmg: number; tank: boolean }> = {
  imp: { level: 1, name: 'Imp', displayId: 4449, hp: 0.5, dmg: 0.85, tank: false },        // Firebolt from range
  voidwalker: { level: 10, name: 'Voidwalker', displayId: 1132, hp: 1.5, dmg: 0.45, tank: true },
  succubus: { level: 20, name: 'Succubus', displayId: 4162, hp: 0.8, dmg: 1.05, tank: false },
  felhunter: { level: 30, name: 'Felhunter', displayId: 850, hp: 1.0, dmg: 0.8, tank: false },
};
/** A tamed beast next to a mob of your level (its Growl holds the mob). */
const BEAST = { hp: 1.0, dmg: 0.85 };

const levelCache = new Map<string, { hp: number; dmgMin: number; dmgMax: number; armor: number }>();
/** The median ordinary mob of a level: what pets are scaled from. */
export function typicalMob(data: GameData, level: number): { hp: number; dmgMin: number; dmgMax: number; armor: number } {
  const key = `${data.builtAt}:${level}`;
  const hit = levelCache.get(key);
  if (hit) return hit;
  const rows = Object.values(data.creatures).filter(c => c.rank === 0 && c.levelMin <= level && c.levelMax >= level)
    .map(c => c.stats[level - c.levelMin]).filter(Boolean);
  const med = (f: (x: CreatureDef['stats'][number]) => number) => {
    const v = rows.map(f).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const out = rows.length
    ? { hp: med(x => x.hp), dmgMin: med(x => x.dmgMin), dmgMax: med(x => x.dmgMax), armor: med(x => x.armor) }
    : { hp: 40 + level * 45, dmgMin: 1 + level * 2, dmgMax: 3 + level * 3, armor: level * 40 };
  levelCache.set(key, out);
  return out;
}

/** The demons a warlock of this level has. */
export function knownDemons(level: number): Exclude<PetKind, 'beast'>[] {
  return (Object.keys(DEMONS) as Exclude<PetKind, 'beast'>[]).filter(k => DEMONS[k].level <= level);
}

/** Whether a creature can be tamed by this hunter: a beast of your level or lower. */
export function tameError(s: GameState, def: CreatureDef | undefined, data?: GameData): string | null {
  if (s.char.cls !== HUNTER) return 'Only hunters can tame beasts.';
  if (s.char.level < TAME_LEVEL) return `You learn Tame Beast at level ${TAME_LEVEL}.`;
  if (!def) return 'Unknown creature.';
  if (def.type !== 1) return 'You can only tame beasts.';
  if (data?.petFamilies && !(def.family && data.petFamilies[def.family])) return "That beast can't be tamed.";
  if (def.rank >= 1 && def.rank <= 3) return "Elites can't be tamed.";
  if (def.levelMin > s.char.level) return 'That beast is too high level to tame.';
  return null;
}

/**
 * The pet that fights with you now: your tamed beast, or your chosen (else best) demon. Warlocks get their
 * demons as they learn them; the Voidwalker is the default once known, since it holds the mob.
 */
export function activePet(s: GameState): Pet | null {
  if (s.char.cls === HUNTER) return s.char.level >= TAME_LEVEL && s.pet?.kind === 'beast' ? s.pet : null;
  if (s.char.cls !== WARLOCK) return null;
  const known = knownDemons(s.char.level);
  const kind = s.pet?.chosen && s.pet.kind !== 'beast' && known.includes(s.pet.kind) ? s.pet.kind : known.includes('voidwalker') ? 'voidwalker' : known[0];
  if (!kind) return null;
  if (s.pet?.kind !== kind) s.pet = { kind, name: DEMONS[kind].name, displayId: DEMONS[kind].displayId };
  return s.pet;
}

export const HAPPY = 666, UNHAPPY = 333, HAPPINESS_PER_KILL = 12, HAPPINESS_PER_FOOD = 350;

/** How happy the pet is: unhappy pets deal 75% damage, happy ones 125% (vanilla). */
export function happinessMod(pet: Pet): number {
  if (pet.kind !== 'beast') return 1;
  const h = pet.happiness ?? 500;
  return h < UNHAPPY ? 0.75 : h > HAPPY ? 1.25 : 1;
}

/** What the pet will eat from your bags (its family's diet), the least valuable first. */
export function petFood(s: GameState, data: GameData, pet: Pet): number | null {
  const diet = pet.family ? data.petFamilies?.[pet.family]?.diet ?? 0 : 0;
  let best: { id: number; price: number } | null = null;
  for (const id of Object.keys(s.inventory)) {
    const it = data.items[+id];
    if (!it?.foodType || !(diet & (1 << (it.foodType - 1))) || it.reqLevel > s.char.level) continue;
    // Pets don't eat food far below their level (vanilla: 30 levels).
    if ((it.itemLevel ?? it.reqLevel) < s.char.level - 30) continue;
    if (!best || it.sellPrice < best.price) best = { id: +id, price: it.sellPrice };
  }
  return best?.id ?? null;
}

/** Special attacks: a beast's Bite/Claw every 8 s, a Succubus's Lash of Pain every 12 s (x1.6 / x1.4 a swing). */
export function petSpecial(pet: Pet): { everyMs: number; mult: number; name: string } | null {
  if (pet.kind === 'beast') return { everyMs: 8000, mult: 1.6, name: 'Bite' };
  if (pet.kind === 'succubus') return { everyMs: 12_000, mult: 1.4, name: 'Lash of Pain' };
  return null;
}

/** Blood Pact: the Imp adds Stamina to its master. */
export function bloodPact(s: GameState): number {
  if (s.char.cls !== WARLOCK || s.pet?.kind !== 'imp' && activePet(s)?.kind !== 'imp') return 0;
  const ranks: [number, number][] = [[4, 3], [14, 9], [26, 17], [38, 29], [50, 42]];
  return [...ranks].reverse().find(([l]) => l <= s.char.level)?.[1] ?? 0;
}

export function petStats(s: GameState, data: GameData, pet: Pet): PetStats {
  const m = typicalMob(data, s.char.level);
  const f = pet.kind === 'beast' ? { ...BEAST, tank: true } : DEMONS[pet.kind];
  const happy = happinessMod(pet);
  return {
    maxHp: Math.round(m.hp * f.hp), armor: Math.round(m.armor * (f.tank ? 1.3 : 0.8)),
    dmgMin: Math.max(1, Math.round(m.dmgMin * f.dmg * happy)), dmgMax: Math.max(1, Math.round(m.dmgMax * f.dmg * happy)), speedMs: 2000, tank: f.tank,
  };
}
