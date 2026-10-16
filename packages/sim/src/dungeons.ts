// Dungeon data: instances split into runs (wings), each an ordered list of encounters, plus the
// abilities creatures cast (from their VMaNGOS spell lists), which become the boss mechanics of the
// group simulation.

/** What a creature's spell does, normalized for the group simulation. Schools: 0 physical .. 6 arcane. */
export type AbilityEffect =
  | { k: 'damage'; school: number; min: number; max: number }
  | { k: 'dot'; school: number; perTick: number; ticks: number; ampMs: number }
  | { k: 'cc'; ms: number }                      // stun, fear, sleep, polymorph: the target loses its turns
  | { k: 'heal'; amount: number }                // heals the caster
  | { k: 'summon'; creature: number; count: number }
  | { k: 'enrage'; pct: number }                 // damage done up
  | { k: 'extraAttacks'; n: number }
  | { k: 'knockback' };                          // the tank loses the mob's attention for a moment

export interface CreatureAbility {
  spell: number; name: string;
  /** Hits everyone near the target instead of one player. */
  aoe: boolean;
  /** Only reaches those in melee range (tanks and melee damage dealers): cleaves, whirlwinds, stomps. */
  melee?: boolean;
  /** Who it's cast at. */
  target: 'tank' | 'random' | 'self';
  /** First cast and repeat delay ranges, ms. */
  firstMs: [number, number]; repeatMs: [number, number];
  chance: number;
  effects: AbilityEffect[];
  /** Its sound (SoundEntries id), when the client has one. */
  sound?: number;
}

/** One pull: a trash pack, or a boss (with any adds in `mobs`). */
/**
 * A boss phase: when it starts (boss health at or below hpPct, or atMs into the fight, repeating every
 * everyMs), the adds that join, whether the boss can't be attacked meanwhile (for some ms, or until the
 * adds are dead), and how much damage the boss takes until its health falls to untilHpPct.
 */
export interface BossPhase {
  name: string;
  hpPct?: number; atMs?: number; everyMs?: number;
  adds?: [number, number][];
  untargetable?: number | 'adds';
  damageTaken?: number; untilHpPct?: number;
}

export interface Encounter { boss?: number; mobs: [number, number][]; phases?: BossPhase[] }

export interface DungeonDef {
  id: number; name: string; map: number;
  /** The zone the instance portal is in (for display). */
  zone: number | null;
  minLevel: number; maxLevel: number;
  /** Players per group: 5, 10 for Upper Blackrock Spire, 20 or 40 for raids. */
  size: number;
  /** Raids: level 60, a lockout that resets every `resetDays`, and wish-list loot. */
  raid?: boolean;
  resetDays?: number;
  /** Raid progression tier (1: Molten Core, Onyxia, Zul'Gurub, Ruins; 2: Blackwing Lair; 3: Temple; 4: Naxxramas). */
  tier?: number;
  /** Attunement: clear this dungeon once, or complete this quest, or reach this reputation [faction, rank]. */
  attune?: { dungeon?: number; quest?: number; rep?: [number, number]; text: string };
  encounters: Encounter[];
}
