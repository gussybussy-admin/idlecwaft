// Player save state. Plain JSON: the server (Phase 3) stores exactly this.
import type { GameData } from './data.js';
import { seedRng, type RngState } from './rng.js';
import type { CombatPhase } from './combat.js';

export type Profession = 'mining' | 'herbalism' | 'fishing' | 'cooking';
export const PROFESSIONS: Profession[] = ['mining', 'herbalism', 'fishing', 'cooking'];

export const SLOTS = ['head', 'neck', 'shoulders', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet',
  'finger1', 'finger2', 'trinket1', 'trinket2', 'mainhand', 'offhand', 'ranged'] as const;
export type Slot = typeof SLOTS[number];

export type Action =
  | { kind: 'fight'; creature: number }
  | { kind: 'gather'; node: number }
  | { kind: 'fish' }
  | { kind: 'cook'; recipe: number }
  | { kind: 'travel'; to: number };

export interface Mob { id: number; level: number; hp: number; maxHp: number }

export type Phase =
  | { p: 'idle' }
  | { p: 'search'; from: number; until: number }
  | CombatPhase
  | { p: 'rest'; eating?: { item: number; perTick: number; until: number } }
  | { p: 'dead'; from: number; until: number }
  | { p: 'work'; from: number; until: number };

export interface LogEntry { t: number; text: string; kind: 'loot' | 'xp' | 'level' | 'skill' | 'death' | 'info' | 'warn' }

export interface GameState {
  v: 1;
  rng: RngState;
  /** Simulation clock (ms since epoch). Everything up to here has been resolved. */
  now: number;
  createdAt: number;
  char: {
    name: string; race: number; cls: number; level: number; xp: number; hp: number; look?: Appearance;
    /** Power: mana (casters), rage in tenths (warriors), energy (rogues); synced lazily on 2 s ticks. */
    mana?: number; rage?: number; energy?: number; powerAt?: number; lastCastAt?: number;
  };
  /** Class spells known (every rank learned; the rotation uses the highest). */
  spells: number[];
  /** Talent ranks by talent id, and how many times they were reset (the price rises). */
  talents: Record<number, number>;
  talentResets?: number;
  gold: number; // copper
  skills: Record<Profession, { level: number; max: number }>; // max 0 = not trained
  recipes: number[];
  inventory: Record<number, number>;
  equipment: Partial<Record<Slot, number>>;
  zone: number;
  /** Discovered flight paths (TaxiNodes ids). */
  taxi: number[];
  /** Riding speed bonus in percent (0, 60, 100). */
  riding: number;
  /** Weapon skill values by SkillLine id (cap 5 x level); Defense is skill 95. */
  combatSkills: Record<number, number>;
  action: Action | null;
  phase: Phase;
  settings: { autoEat: boolean; eatBelowPct: number; restBelowPct: number };
  stats: { kills: Record<number, number>; deaths: number; gathered: number; caught: number; cooked: number };
  log: LogEntry[];
}

/** Character appearance (CharSections variations); purely cosmetic. */
export interface Appearance { sex: number; skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number }

export interface NewCharacter { name: string; race: number; cls: number; seed: number; now: number; look?: Appearance }

export function newGame(data: GameData, c: NewCharacter): GameState {
  const state: GameState = {
    v: 1, rng: seedRng(c.seed), now: c.now, createdAt: c.now,
    char: { name: c.name, race: c.race, cls: c.cls, level: 1, xp: 0, hp: 1, ...(c.look ? { look: c.look } : {}) },
    gold: 0,
    skills: { mining: { level: 0, max: 0 }, herbalism: { level: 0, max: 0 }, fishing: { level: 0, max: 0 }, cooking: { level: 0, max: 0 } },
    recipes: [], inventory: {}, equipment: {},
    zone: data.startZones?.[c.race] ?? data.zones[0]?.id ?? 12,
    taxi: [], riding: 0, combatSkills: { 95: 1, 162: 1 },
    // Starting spells (free at level 1), e.g. Heroic Strike, Fireball, Smite.
    spells: (data.classSpells?.[c.cls] ?? []).filter(o => o.level <= 1 && o.cost === 0).map(o => o.spell),
    talents: {},
    action: null, phase: { p: 'idle' },
    settings: { autoEat: true, eatBelowPct: 50, restBelowPct: 60 },
    stats: { kills: {}, deaths: 0, gathered: 0, caught: 0, cooked: 0 },
    log: [],
  };
  // Start at full health: base class HP + stamina HP (see playerStats).
  const [, , sta] = data.levelStats[c.race]?.[c.cls]?.[1] ?? [20, 20, 20, 20, 20];
  state.char.hp = (data.classStats[c.cls]?.[1]?.[0] ?? 20) + (sta <= 20 ? sta : 20 + (sta - 20) * 10);
  const int0 = data.levelStats[c.race]?.[c.cls]?.[1]?.[3] ?? 20, baseMana = data.classStats[c.cls]?.[1]?.[1] ?? 0;
  state.char.mana = baseMana ? baseMana + (int0 <= 20 ? int0 : 20 + (int0 - 20) * 15) : 0;
  state.char.rage = 0;
  state.char.energy = 100;
  state.char.powerAt = c.now;
  // Starting zones come with their flight master known (vanilla players walk to it in minutes).
  for (const id of data.zones.find(z => z.id === state.zone)?.taxiNodes ?? []) state.taxi.push(id);
  return state;
}

/** Brings saves from older data versions up to date (new fields get their defaults). */
export function migrateState(s: GameState): GameState {
  s.taxi ??= [];
  s.riding ??= 0;
  // Characters from before weapon skills: start them at their level's cap, as if they'd always had them.
  s.combatSkills ??= { 95: s.char.level * 5, 162: s.char.level * 5 };
  s.spells ??= [];
  s.talents ??= {};
  s.char.mana ??= 0; s.char.rage ??= 0; s.char.energy ??= 100; s.char.powerAt ??= s.now;
  return s;
}

export function addItem(s: GameState, item: number, n: number): void {
  s.inventory[item] = (s.inventory[item] ?? 0) + n;
  if (s.inventory[item] <= 0) delete s.inventory[item];
}

export function hasItem(s: GameState, item: number, n = 1): boolean {
  return (s.inventory[item] ?? 0) >= n;
}

const LOG_MAX = 80;
export function log(s: GameState, kind: LogEntry['kind'], text: string): void {
  s.log.push({ t: s.now, kind, text });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
}
