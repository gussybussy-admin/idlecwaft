// Profession data: rank spells, recipes for every crafting skill (from SkillLineAbility.dbc plus the
// spell table), and the item enchantments those recipes apply (SpellItemEnchantment.dbc).
import type { EnchantDef, Profession, RecipeDef, SkillRank } from '@idle/sim';
import type { Client } from '../client.js';
import type { VMangos } from './vmangos.js';

/** SkillLine ids. Smelting recipes belong to Mining. */
export const SKILL_LINE: Record<Profession, number> = {
  mining: 186, herbalism: 182, skinning: 393, fishing: 356, cooking: 185, firstaid: 129,
  alchemy: 171, blacksmithing: 164, enchanting: 333, engineering: 202, leatherworking: 165, tailoring: 197,
};

/** Rank spells (Apprentice, Journeyman, Expert, Artisan). Costs and levels come from trainer data. */
const RANK_SPELLS: Record<Profession, number[]> = {
  mining: [2575, 2576, 3564, 10248], herbalism: [2366, 2368, 3570, 11993], fishing: [7620, 7731, 7732, 18248],
  cooking: [2550, 3102, 3413, 18260], skinning: [8613, 8617, 8618, 10768], firstaid: [3273, 3274, 7924, 10846],
  alchemy: [2259, 3101, 3464, 11611], blacksmithing: [2018, 3100, 3538, 9785], enchanting: [7411, 7412, 7413, 13920],
  engineering: [4036, 4037, 4038, 12656], leatherworking: [2108, 3104, 3811, 10662], tailoring: [3908, 3909, 3910, 12180],
};
const RANK_NAMES = ['Apprentice', 'Journeyman', 'Expert', 'Artisan'];
const RANK_LEVELS = [5, 10, 20, 35];
const RANK_COSTS = [10, 500, 5000, 50000]; // for ranks taught by books/quests rather than trainers

const SPELL_EFFECT_CREATE_ITEM = 24, SPELL_EFFECT_ENCHANT_ITEM = 53;
const SLA_LEARNED_WITH_SKILL = 1;

export function buildSkillRanks(vm: VMangos): Record<Profession, SkillRank[]> {
  const out = {} as Record<Profession, SkillRank[]>;
  for (const [skill, spells] of Object.entries(RANK_SPELLS) as [Profession, number[]][]) {
    out[skill] = spells.map((spellId, i): SkillRank => {
      const t = vm.trainerOffer(spellId);
      return { name: RANK_NAMES[i], max: 75 * (i + 1), reqLevel: t?.reqLevel || RANK_LEVELS[i], cost: t?.cost ?? RANK_COSTS[i], spellId };
    });
  }
  return out;
}

/**
 * Every recipe whose reagents the world can supply. `obtainable` starts as everything that drops,
 * is sold or is gathered; recipes are accepted in passes, each accepted product becoming obtainable
 * (bars -> armor, bolts of cloth -> shirts), until nothing changes.
 */
export function buildRecipes(client: Client, vm: VMangos, castTimes: Map<number, number>, obtainable: Set<number>): Record<number, RecipeDef> {
  const skillOf = new Map(Object.entries(SKILL_LINE).map(([k, v]) => [v, k as Profession]));
  const sla = client.dbc('SkillLineAbility'); // 1 skill, 2 spell, 7 minRank, 9 acquire, 10 grey (trivial high), 11 yellow (trivial low)
  type Candidate = Omit<RecipeDef, 'source'> & { source: RecipeDef['source'] };
  const candidates: Candidate[] = [];
  for (const r of sla.rows()) {
    const skill = skillOf.get(sla.u32(r, 1));
    if (!skill || !sla.u32(r, 10)) continue;
    const spellId = sla.u32(r, 2);
    const s = vm.spell(spellId);
    if (!s) continue;
    const effect = Number(s.effect1);
    const creates = effect === SPELL_EFFECT_CREATE_ITEM && Number(s.effectItemType1);
    const enchants = effect === SPELL_EFFECT_ENCHANT_ITEM && Number(s.effectMiscValue1);
    if (!creates && !enchants) continue;
    const reagents: [number, number][] = [];
    for (let i = 1; i <= 8; i++) if (Number(s[`reagent${i}`])) reagents.push([Number(s[`reagent${i}`]), Number(s[`reagentCount${i}`])]);
    if (!reagents.length) continue;
    const learnedWithSkill = sla.u32(r, 9) === SLA_LEARNED_WITH_SKILL;
    const trainer = learnedWithSkill ? { cost: 0, reqSkill: sla.u32(r, 7), reqLevel: 0 } : vm.trainerOffer(spellId);
    const recipeItem = trainer ? undefined : vm.recipeItem(spellId);
    if (!trainer && !recipeItem) continue;
    const grey = sla.u32(r, 10), yellow = sla.u32(r, 11);
    const tools = [Number(s.totem1), Number(s.totem2)].filter(Boolean);
    candidates.push({
      spellId, name: String(s.name), skill, item: creates || 0,
      count: creates ? Math.max(1, Number(s.effectBasePoints1) + 1) : 1, reagents,
      ...(tools.length ? { tools } : {}),
      ...(enchants ? { enchant: { id: enchants, itemClass: Number(s.equippedItemClass), invMask: Number(s.equippedItemInventoryTypeMask) } } : {}),
      orange: (trainer ? trainer.reqSkill : Number(recipeItem?.required_skill_rank)) || 1,
      yellow, green: Math.floor((yellow + grey) / 2), grey,
      castMs: castTimes.get(Number(s.castingTimeIndex)) || 3000,
      source: trainer ? { trainer: trainer.cost } : { recipeItem: Number(recipeItem!.entry) },
    });
  }
  const have = new Set(obtainable);
  const recipes: Record<number, RecipeDef> = {};
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates) {
      if (recipes[c.spellId]) continue;
      if (!c.reagents.every(([id]) => have.has(id))) continue;
      if ('recipeItem' in c.source && !have.has(c.source.recipeItem)) continue; // the recipe itself must drop or be sold
      recipes[c.spellId] = c;
      if (c.item && !have.has(c.item)) { have.add(c.item); changed = true; }
    }
  }
  for (const r of Object.values(recipes)) {
    obtainable.add(r.item);
    for (const [id] of r.reagents) obtainable.add(id);
    for (const t of r.tools ?? []) obtainable.add(t);
    if ('recipeItem' in r.source) obtainable.add(r.source.recipeItem);
  }
  obtainable.delete(0);
  return recipes;
}

// Spell aura -> enchant field (equip-spell enchantments, type 3).
const STAT_FROM_MISC: Record<number, number> = { 0: 4, 1: 3, 2: 7, 3: 5, 4: 6 }; // str agi sta int spi -> item stat ids

export function buildEnchants(client: Client, vm: VMangos, ids: Set<number>): Record<number, EnchantDef> {
  const sie = client.dbc('SpellItemEnchantment'); // 0 id, 1-3 type, 4-6 amount, 10-12 object (spell / stat), 13 name
  const out: Record<number, EnchantDef> = {};
  for (const r of sie.rows()) {
    const id = sie.u32(r, 0);
    if (!ids.has(id)) continue;
    const e: EnchantDef = { id, name: sie.str(r, 13), stats: [], hp: 0, mana: 0, armor: 0, ap: 0, dmg: 0 };
    for (let i = 0; i < 3; i++) {
      const type = sie.u32(r, 1 + i), amount = sie.i32(r, 4 + i), obj = sie.u32(r, 10 + i);
      if (type === 2) e.dmg += amount;
      else if (type === 4 && obj === 0) e.armor += amount;
      else if (type === 3 && obj) {
        const s = vm.spell(obj);
        if (!s) continue;
        for (let k = 1; k <= 3; k++) {
          if (Number(s[`effect${k}`]) !== 6) continue;
          const aura = Number(s[`effectApplyAuraName${k}`]), misc = Number(s[`effectMiscValue${k}`]);
          const v = Number(s[`effectBasePoints${k}`]) + 1;
          if (aura === 29) {
            if (misc === -1) for (const st of [3, 4, 5, 6, 7]) e.stats.push([st, v]);
            else if (STAT_FROM_MISC[misc]) e.stats.push([STAT_FROM_MISC[misc], v]);
          } else if (aura === 34) e.hp += v;
          else if (aura === 35 && misc === 0) e.mana += v;
          else if (aura === 22 && (misc & 1)) e.armor += v;
          else if (aura === 99) e.ap += v;
        }
      }
    }
    out[id] = e;
  }
  return out;
}
