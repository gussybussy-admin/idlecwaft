// Vanilla-flavoured formulas. Sources: MaNGOS/VMaNGOS (XP, gray levels, skill-up chances,
// fishing), plus documented approximations where an idle game needs a closed form (see DESIGN.md).

// ---------- XP (MaNGOS::XP)
export function grayLevel(pl: number): number {
  if (pl <= 5) return 0;
  if (pl <= 39) return pl - 5 - Math.floor(pl / 10);
  if (pl <= 59) return pl - 1 - Math.floor(pl / 5);
  return pl - 9;
}

export function zeroDifference(pl: number): number {
  if (pl < 8) return 5; if (pl < 10) return 6; if (pl < 12) return 7; if (pl < 16) return 8;
  if (pl < 20) return 9; if (pl < 30) return 11; if (pl < 40) return 12; if (pl < 45) return 13;
  if (pl < 50) return 14; if (pl < 55) return 15; if (pl < 60) return 16; return 17;
}

/** XP for killing a mob of `mob` level; elites (rank 1-3) give double. */
export function killXp(pl: number, mob: number, rank = 0): number {
  let xp: number;
  if (mob >= pl) {
    const diff = Math.min(mob - pl, 4);
    xp = Math.floor(((pl * 5 + 45) * (20 + diff) / 10 + 1) / 2);
  } else if (mob > grayLevel(pl)) {
    const zd = zeroDifference(pl);
    xp = Math.floor((pl * 5 + 45) * (zd + mob - pl) / zd);
  } else xp = 0;
  return rank >= 1 && rank <= 3 ? xp * 2 : xp;
}

// ---------- skill colours and skill-up chances (VMaNGOS defaults: orange 100, yellow 75, green 25, grey 0)
export type SkillColor = 'red' | 'orange' | 'yellow' | 'green' | 'grey';
export const SKILLUP_CHANCE: Record<SkillColor, number> = { red: 0, orange: 100, yellow: 75, green: 25, grey: 0 };

/** Gathering colours from the node's required skill: orange < +25, yellow < +50, green < +100. */
export function gatherColor(skill: number, req: number): SkillColor {
  if (skill < req) return 'red';
  if (skill < req + 25) return 'orange';
  if (skill < req + 50) return 'yellow';
  if (skill < req + 100) return 'green';
  return 'grey';
}

export function recipeColor(skill: number, r: { orange: number; yellow: number; green: number; grey: number }): SkillColor {
  if (skill < r.orange) return 'red';
  if (skill < r.yellow) return 'orange';
  if (skill < r.green) return 'yellow';
  if (skill < r.grey) return 'green';
  return 'grey';
}

/** Fishing: catch chance (%) vs the zone's base skill, and the chance (%) a catch gives a skill point. */
export function fishingCatchChance(skill: number, zoneSkill: number): number {
  return Math.max(0, Math.min(100, skill - zoneSkill + 5));
}
export function fishingSkillupChance(skill: number): number {
  return skill < 75 ? 100 : Math.min(100, 2500 / (skill - 50));
}

// ---------- weapon skills (SkillLine ids) and armor proficiencies
export const SKILL_DEFENSE = 95, SKILL_UNARMED = 162;
/** Weapon item subclass -> weapon skill. */
export const WEAPON_SKILL: Record<number, number> = {
  0: 44, 1: 172, 2: 45, 3: 46, 4: 54, 5: 160, 6: 229, 7: 43, 8: 55, 10: 136, 13: 473, 15: 173, 16: 176, 18: 226, 19: 228,
};
/** Armor item subclass -> armor proficiency skill (cloth, leather, mail, plate, shield). */
export const ARMOR_SKILL: Record<number, number> = { 1: 415, 2: 414, 3: 413, 4: 293, 6: 433 };

/** Chance (%) that a swing (or a hit taken, for Defense) raises the skill; fast when far below the cap. */
export function combatSkillupChance(skill: number, max: number): number {
  return skill >= max ? 0 : Math.max(0.5, 100 * (max - skill) / max);
}

// ---------- player stats
export const STAT = { AGI: 3, STR: 4, INT: 5, SPI: 6, STA: 7 } as const;

export function healthFromStamina(sta: number): number {
  return sta <= 20 ? sta : 20 + (sta - 20) * 10;
}

/** Melee attack power by class (1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue, 5 Priest, 7 Shaman, 8 Mage, 9 Warlock, 11 Druid). */
export function meleeAttackPower(cls: number, level: number, str: number, agi: number): number {
  switch (cls) {
    case 1: case 2: return Math.max(0, str * 2 + level * 3 - 20);
    case 3: case 4: return Math.max(0, str + agi + level * 2 - 20);
    case 7: return Math.max(0, str * 2 + level * 2 - 20);
    case 11: return Math.max(0, str * 2 - 20);
    default: return Math.max(0, str - 10);
  }
}

/**
 * Natural out-of-combat health regeneration per second: deliberately only 1 HP per minute, so food
 * (fishing, cooking, vendors) is how a fighter recovers. Spirit doesn't change it (design choice).
 */
export function healthRegenPerSec(_spirit: number): number {
  return 1 / 60;
}

/** Miss chance (%) for an attacker with `skill` against `defense` (both 5 per level for mobs). */
export function missChance(attackerSkill: number, defense: number): number {
  const diff = defense - attackerSkill;
  return Math.max(0, diff <= 10 ? 5 + diff * 0.1 : 7 + (diff - 10) * 0.4);
}

/** Armor damage reduction (fraction) against an attacker of `attackerLevel`. */
export function armorReduction(armor: number, attackerLevel: number): number {
  return Math.min(0.75, armor / (armor + 400 + 85 * attackerLevel));
}

/** Skinning skill a corpse needs (vanilla: free below level 10, 10 per level to 20, then 5 per level). */
export function skinningReq(mobLevel: number): number {
  return mobLevel < 10 ? 1 : mobLevel < 20 ? (mobLevel - 10) * 10 : mobLevel * 5;
}

/** Enchanting skill needed to disenchant an item of this item level (vanilla brackets). */
export function disenchantReq(itemLevel: number): number {
  if (itemLevel <= 20) return 1;
  return Math.min(300, 25 * Math.ceil((itemLevel - 20) / 5));
}
