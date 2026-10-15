// Talent trees from Talent.dbc / TalentTab.dbc, with each rank's spell normalized into TalentEffects.
import type { SpellModOp, TalentDef, TalentEffect, TalentStat, TalentTabDef } from '@idle/sim';
import type { Client } from '../client.js';
import type { Row, VMangos } from './vmangos.js';

const STAT: Record<number, TalentStat | 'all'> = { [-1]: 'all', 0: 'str', 1: 'agi', 2: 'sta', 3: 'int', 4: 'spi' };
const SPELLMOD: Record<number, SpellModOp> = { 0: 'damage', 7: 'crit', 10: 'castTime', 11: 'cooldown', 14: 'cost' };
/** SpellFamilyName per class (talent spells select their class's spells by it). */
export const CLASS_FAMILY: Record<number, number> = { 1: 4, 2: 10, 3: 9, 4: 8, 5: 6, 7: 11, 8: 3, 9: 5, 11: 7 };

export function buildTalents(client: Client, vm: VMangos): { talents: Record<number, TalentDef>; talentTabs: Record<number, TalentTabDef> } {
  const iconDbc = client.dbc('SpellIcon');
  const icons = new Map(iconDbc.rows().map(r => [iconDbc.u32(r, 0), iconDbc.str(r, 1).split('\\').pop() ?? '']));
  const tt = client.dbc('TalentTab'); // 0 id, 1 name, 10 icon, 12 classMask, 13 order, 14 background
  const talentTabs: Record<number, TalentTabDef> = {};
  for (const r of tt.rows()) {
    const mask = tt.u32(r, 12);
    if (!mask) continue;
    talentTabs[tt.u32(r, 0)] = {
      id: tt.u32(r, 0), name: tt.str(r, 1), cls: Math.log2(mask) + 1, order: tt.u32(r, 13),
      icon: icons.get(tt.u32(r, 10)) ?? 'INV_Misc_QuestionMark', background: tt.str(r, 14),
    };
  }
  const ta = client.dbc('Talent'); // 0 id, 1 tab, 2 row, 3 col, 4-12 rank spells, 13 prereq talent, 16 prereq rank (0-based)
  const talents: Record<number, TalentDef> = {};
  for (const r of ta.rows()) {
    const tab = talentTabs[ta.u32(r, 1)];
    if (!tab) continue;
    const ranks: number[] = [];
    for (let f = 4; f <= 12; f++) if (ta.u32(r, f)) ranks.push(ta.u32(r, f));
    if (!ranks.length) continue;
    const spells = ranks.map(id => vm.spell(id));
    const first = spells[0];
    const id = ta.u32(r, 0);
    const prereq = ta.u32(r, 13);
    talents[id] = {
      id, tab: tab.id, row: ta.u32(r, 2), col: ta.u32(r, 3), ranks,
      ...(prereq ? { requires: { talent: prereq, rank: ta.u32(r, 16) + 1 } } : {}),
      name: String(first?.name ?? `Talent ${id}`),
      icon: icons.get(Number(first?.spellIconId)) ?? 'INV_Misc_QuestionMark',
      description: describe(first),
      effects: spells.map(s => (s ? talentEffects(s, CLASS_FAMILY[tab.cls] ?? 0) : [])),
    };
  }
  return { talents, talentTabs };
}

function talentEffects(s: Row, classFamily: number): TalentEffect[] {
  const n = (k: string) => Number(s[k] ?? 0);
  const out: TalentEffect[] = [];
  const family = n('spellFamilyName') || classFamily;
  for (let e = 1; e <= 3; e++) {
    if (n(`effect${e}`) !== 6) continue; // APPLY_AURA
    const aura = n(`effectApplyAuraName${e}`), misc = n(`effectMiscValue${e}`);
    const v = n(`effectBasePoints${e}`) + Math.max(1, n(`effectBaseDice${e}`));
    switch (aura) {
      case 29: if (STAT[misc]) out.push({ k: 'stat', stat: STAT[misc], amount: v }); break;
      case 137: if (STAT[misc]) out.push({ k: 'statPct', stat: STAT[misc], pct: v }); break;
      case 133: out.push({ k: 'healthPct', pct: v }); break;
      case 132: if (misc === 0) out.push({ k: 'manaPct', pct: v }); break;
      case 52: out.push({ k: 'meleeCrit', pct: v }); break;
      case 57: case 71: out.push({ k: 'spellCrit', pct: v }); break;
      case 54: out.push({ k: 'meleeHit', pct: v }); break;
      case 55: out.push({ k: 'spellHit', pct: v }); break;
      case 49: out.push({ k: 'dodge', pct: v }); break;
      case 22: if (misc & 1) out.push({ k: 'armor', amount: v }); break;
      case 101: if (misc & 1) out.push({ k: 'armorPct', pct: v }); break;
      case 99: out.push({ k: 'ap', amount: v }); break;
      case 79: out.push({ k: 'schoolDamage', schools: misc, pct: v }); break;
      case 107: case 108: {
        const op = SPELLMOD[misc];
        const mask = n(`effectItemType${e}`);
        if (op && mask) out.push({ k: 'spellMod', op, flat: aura === 107 ? v : 0, pct: aura === 108 ? v : 0, family, mask });
        break;
      }
    }
  }
  return out;
}

/** The client's description with $s1-style placeholders filled from rank 1. */
function describe(s: Row | undefined): string {
  if (!s) return '';
  const val = (i: number) => Number(s[`effectBasePoints${i}`] ?? 0) + Math.max(1, Number(s[`effectBaseDice${i}`] ?? 1));
  return String(s.description ?? '')
    .replace(/\$s(\d)/g, (_, i) => String(Math.abs(val(+i))))
    .replace(/\$\/1000;s(\d)/g, (_, i) => String(Math.abs(val(+i)) / 1000))
    .replace(/\$d/g, 'a while')
    .replace(/\$[a-z]\d?/gi, '')
    .replace(/\s+/g, ' ').trim();
}
