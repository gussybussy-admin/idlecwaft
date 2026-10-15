// Class spells, normalized from the 1.12 spell data into the effects an idle fight can use.
import type { Copper } from './data.js';

export type Power = 'mana' | 'rage' | 'energy' | 'health';
export type BuffStat = 'str' | 'agi' | 'sta' | 'int' | 'spi' | 'all' | 'ap' | 'rap' | 'armor' | 'haste';

export type SpellEffect =
  /** School damage: base..base+dice, + perLevel per level above the spell's level; perCombo for finishers. */
  | { k: 'damage'; base: number; dice: number; perLevel: number; perCombo: number }
  /** Weapon strike: a weapon swing plus `flat`, or `pct` percent of a swing. */
  | { k: 'weapon'; flat: number; pct: number }
  | { k: 'heal'; base: number; dice: number; perLevel: number }
  | { k: 'dot'; perTick: number; ampMs: number }
  | { k: 'hot'; perTick: number; ampMs: number }
  | { k: 'shield'; amount: number; perLevel: number }
  /** Channelled: deals the triggered spell's damage every ampMs for the duration. */
  | { k: 'channel'; base: number; dice: number; perLevel: number; ampMs: number }
  | { k: 'combo'; n: number }
  | { k: 'energize'; amount: number }
  /** Self buffs: treated as always on once learned (rebuffing is out-of-combat busywork). */
  | { k: 'buff'; stat: BuffStat; amount: number; perLevel: number }
  /** Weakens the target: its attack power (amount negative) or attack speed (percent, negative). */
  | { k: 'debuff'; stat: 'ap' | 'haste'; amount: number; perLevel: number }
  /** Damage dealt back to an attacker each time it hits you (Thorns, Lightning Shield). */
  | { k: 'thorns'; amount: number; perLevel: number }
  /** Paladin seal: extra holy damage on each melee swing. */
  | { k: 'seal'; amount: number; perLevel: number }
  /** Conjures an item (Conjure Food / Water). */
  | { k: 'conjure'; item: number; count: number; perLevel: number };

export interface SpellDef {
  id: number;
  name: string;
  rank: string;
  icon: string;
  /** First spell of the rank chain (ranks of the same spell share it). */
  chain: number;
  school: number;       // 0 physical, 1 holy, 2 fire, 3 nature, 4 frost, 5 shadow, 6 arcane
  dmgClass: number;     // 0 none, 1 magic, 2 melee, 3 ranged
  power: Power;
  cost: number;         // mana; rage and energy in tenths/points as in the client (Heroic Strike: 150 = 15 rage)
  castMs: number;
  cooldownMs: number;
  gcdMs: number;
  durationMs: number;
  spellLevel: number;
  maxLevel: number;
  /** Replaces the next melee swing instead of using the GCD (Heroic Strike, Cleave, Raptor Strike). */
  nextSwing: boolean;
  /** SpellFamilyName and the low 32 bits of SpellFamilyFlags: what talents' spell modifiers select on. */
  family: number;
  familyFlags: number;
  /** Only usable right after something happened (Overpower after a dodge, Revenge after you avoid a hit, Execute below 20%). */
  requires?: 'target-dodged' | 'self-avoided' | 'target-below-20';
  effects: SpellEffect[];
}

export interface ClassSpellOffer { spell: number; level: number; cost: Copper }

/** Value of a level-scaled number at character level `level`. */
export function scaled(base: number, perLevel: number, spell: SpellDef, level: number): number {
  const cap = spell.maxLevel > 0 ? Math.min(level, spell.maxLevel) : level;
  return base + perLevel * Math.max(0, cap - spell.spellLevel);
}
