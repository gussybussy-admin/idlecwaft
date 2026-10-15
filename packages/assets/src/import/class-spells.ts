// Class spells from trainer data + the client's spell table, normalized into SpellEffects.
import type { BuffStat, ClassSpellOffer, Power, SpellDef, SpellEffect } from '@idle/sim';
import type { Client } from '../client.js';
import { PATCH_1_12, VMangos, type Row } from './vmangos.js';

const POWER: Record<number, Power> = { 0: 'mana', 1: 'rage', 3: 'energy', 4294967294: 'health', [-2]: 'health' };
const STAT_BY_MISC: Record<number, BuffStat> = { [-1]: 'all', 0: 'str', 1: 'agi', 2: 'sta', 3: 'int', 4: 'spi' };
const REQUIRES: Record<string, SpellDef['requires']> = {
  Overpower: 'target-dodged', Revenge: 'self-avoided', Riposte: 'self-avoided', Execute: 'target-below-20',
};
const HEAL_SCRIPTED = /^(Holy Light|Flash of Light)$/;
const RANGED_AUTO = new Set(['Shoot', 'Throw', 'Auto Shot']);

export interface ClassSpellData {
  spells: Record<number, SpellDef>;
  classSpells: Record<number, ClassSpellOffer[]>;
}

export function buildClassSpells(client: Client, vm: VMangos, castTimes: Map<number, number>, durations: Map<number, number>): ClassSpellData {
  const iconDbc = client.dbc('SpellIcon');
  const icons = new Map(iconDbc.rows().map(r => [iconDbc.u32(r, 0), iconDbc.str(r, 1).split('\\').pop() ?? '']));
  const chainFirst = new Map<number, number>();
  for (const r of vm.all(`SELECT spell_id, first_spell FROM spell_chain WHERE build_min<=5875 AND build_max>=5875`)) chainFirst.set(Number(r.spell_id), Number(r.first_spell));

  const spells: Record<number, SpellDef> = {};
  const classSpells: Record<number, ClassSpellOffer[]> = {};
  const def = (id: number): SpellDef | null => {
    if (spells[id]) return spells[id];
    const s = vm.spell(id);
    if (!s) return null;
    const d = spellDef(s, vm, icons, castTimes, durations, chainFirst.get(id) ?? id);
    if (d) spells[id] = d;
    return d;
  };

  for (let cls = 1; cls <= 11; cls++) {
    const offers = new Map<number, ClassSpellOffer>();
    const offer = (spell: number, level: number, cost: number) => {
      const prev = offers.get(spell);
      if (!prev || level < prev.level || (level === prev.level && cost < prev.cost)) offers.set(spell, { spell, level, cost });
    };
    const trainers = vm.all(`SELECT entry, trainer_id FROM creature_template WHERE trainer_type=0 AND trainer_class=? AND patch<=?`, cls, PATCH_1_12);
    for (const t of trainers) {
      const rows = [...vm.all(`SELECT spell, spellcost, reqlevel FROM npc_trainer WHERE entry=? AND build_min<=5875 AND build_max>=5875`, t.entry),
        ...(Number(t.trainer_id) ? vm.all(`SELECT spell, spellcost, reqlevel FROM npc_trainer_template WHERE entry=? AND build_min<=5875 AND build_max>=5875`, Number(t.trainer_id)) : [])];
      for (const r of rows) {
        const teach = vm.spell(Number(r.spell));
        const real = teach && Number(teach.effect1) === 36 ? Number(teach.effectTriggerSpell1) : Number(r.spell);
        if (def(real)) offer(real, Number(r.reqlevel) || def(real)!.spellLevel || 1, Number(r.spellcost));
      }
    }
    for (const r of vm.all(`SELECT DISTINCT spell FROM playercreateinfo_spell WHERE class=? AND build_min<=5875 AND build_max>=5875`, cls)) {
      if (def(Number(r.spell))) offer(Number(r.spell), 1, 0);
    }
    if (offers.size) classSpells[cls] = [...offers.values()].sort((a, b) => a.level - b.level || a.spell - b.spell);
  }
  return { spells, classSpells };
}

function spellDef(s: Row, vm: VMangos, icons: Map<number, string>, castTimes: Map<number, number>, durations: Map<number, number>, chain: number): SpellDef | null {
  const n = (k: string) => Number(s[k] ?? 0);
  const name = String(s.name);
  if (RANGED_AUTO.has(name)) return null; // wand / thrown / gun auto attacks need the ranged slot (not idleized yet)
  const effects: SpellEffect[] = [];
  const val = (e: number) => {
    const bp = n(`effectBasePoints${e}`), baseDice = n(`effectBaseDice${e}`), die = n(`effectDieSides${e}`);
    const min = bp + baseDice, max = bp + Math.max(baseDice, die);
    return { min, dice: max - min, perLevel: n(`effectRealPointsPerLevel${e}`), perCombo: n(`effectPointsPerComboPoint${e}`) };
  };
  const durationMs = durations.get(n('durationIndex')) ?? 0;
  for (let e = 1; e <= 3; e++) {
    const effect = n(`effect${e}`), aura = n(`effectApplyAuraName${e}`), misc = n(`effectMiscValue${e}`);
    if (!effect) continue;
    const v = val(e);
    switch (effect) {
      case 2: effects.push({ k: 'damage', base: v.min, dice: v.dice, perLevel: v.perLevel, perCombo: v.perCombo }); break;
      case 10: effects.push({ k: 'heal', base: v.min, dice: v.dice, perLevel: v.perLevel }); break;
      case 77: if (HEAL_SCRIPTED.test(name)) effects.push({ k: 'heal', base: v.min, dice: v.dice, perLevel: v.perLevel }); break;
      case 17: case 58: case 121: effects.push({ k: 'weapon', flat: v.min + v.dice / 2, pct: 0 }); break;
      case 31: effects.push({ k: 'weapon', flat: 0, pct: v.min }); break;
      case 80: effects.push({ k: 'combo', n: v.min }); break;
      case 30: effects.push({ k: 'energize', amount: v.min }); break;
      case 24: if (n(`effectItemType${e}`)) effects.push({ k: 'conjure', item: n(`effectItemType${e}`), count: v.min, perLevel: v.perLevel }); break;
      case 6: case 35: {
        switch (aura) {
          case 3: effects.push({ k: 'dot', perTick: v.min, ampMs: n(`effectAmplitude${e}`) || 3000 }); break;
          case 8: effects.push({ k: 'hot', perTick: v.min, ampMs: n(`effectAmplitude${e}`) || 3000 }); break;
          case 69: effects.push({ k: 'shield', amount: v.min, perLevel: v.perLevel }); break;
          case 23: {
            const t = vm.spell(n(`effectTriggerSpell${e}`));
            if (t && Number(t.effect1) === 2) {
              const bp = Number(t.effectBasePoints1), bd = Number(t.effectBaseDice1), die = Number(t.effectDieSides1);
              effects.push({ k: 'channel', base: bp + bd, dice: Math.max(bd, die) - bd, perLevel: Number(t.effectRealPointsPerLevel1), ampMs: n(`effectAmplitude${e}`) || 1000 });
            }
            break;
          }
          case 29: if (v.min > 0 && STAT_BY_MISC[misc]) effects.push({ k: 'buff', stat: STAT_BY_MISC[misc], amount: v.min, perLevel: v.perLevel }); break;
          case 99: effects.push(v.min > 0 ? { k: 'buff', stat: 'ap', amount: v.min, perLevel: v.perLevel } : { k: 'debuff', stat: 'ap', amount: v.min, perLevel: v.perLevel }); break;
          case 124: if (v.min > 0) effects.push({ k: 'buff', stat: 'rap', amount: v.min, perLevel: v.perLevel }); break;
          case 22: if ((misc & 1) && v.min > 0) effects.push({ k: 'buff', stat: 'armor', amount: v.min, perLevel: v.perLevel }); break;
          case 138: if (v.min < 0) effects.push({ k: 'debuff', stat: 'haste', amount: v.min, perLevel: 0 });
            else if (durationMs >= 60_000) effects.push({ k: 'buff', stat: 'haste', amount: v.min, perLevel: 0 }); break;
          case 15: effects.push({ k: 'thorns', amount: v.min, perLevel: v.perLevel }); break;
          case 42: {
            const t = vm.spell(n(`effectTriggerSpell${e}`));
            if (t && Number(t.effect1) === 2 && /Lightning Shield/.test(name)) effects.push({ k: 'thorns', amount: Number(t.effectBasePoints1) + Number(t.effectBaseDice1), perLevel: 0 });
            break;
          }
          case 4: if (/^Seal of Righteousness/.test(name)) effects.push({ k: 'seal', amount: v.min, perLevel: v.perLevel }); break;
        }
        break;
      }
    }
  }
  if (!effects.length) return null;
  const power = POWER[n('powerType')] ?? 'mana';
  const castMs = effects.some(x => x.k === 'channel') ? durationMs : (castTimes.get(n('castingTimeIndex')) ?? 0);
  const gcdMs = n('startRecoveryTime');
  const dmgClass = n('dmgClass');
  return {
    id: Number(s.entry), name, rank: String(s.nameSubtext ?? ''), icon: icons.get(n('spellIconId')) ?? 'INV_Misc_QuestionMark',
    chain, school: n('school'), dmgClass, power, cost: n('manaCost'), castMs: Math.max(0, castMs), gcdMs, durationMs,
    family: n('spellFamilyName'), familyFlags: Number(BigInt.asUintN(32, BigInt(String(s.spellFamilyFlags ?? 0)))),
    cooldownMs: Math.max(n('recoveryTime'), n('categoryRecoveryTime')),
    spellLevel: n('spellLevel'), maxLevel: n('maxLevel'),
    nextSwing: gcdMs === 0 && dmgClass === 2 && effects.some(x => x.k === 'weapon') && castMs === 0,
    ...(REQUIRES[name] ? { requires: REQUIRES[name] } : {}),
    effects,
  };
}
