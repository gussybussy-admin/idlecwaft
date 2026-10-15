// Dev helper: what a class learns from its trainers, with each spell's effects.
//   tsx class-spells.ts <classId> [maxLevel]
import { findRepoRoot } from '../config.js';
import { VMangos, PATCH_1_12 } from '../import/vmangos.js';

const vm = VMangos.open(findRepoRoot());
const cls = Number(process.argv[2] ?? 1), maxLevel = Number(process.argv[3] ?? 20);
const trainers = vm.all(`SELECT entry, trainer_id FROM creature_template WHERE trainer_type=0 AND trainer_class=? AND patch<=?`, cls, PATCH_1_12);
const offers = new Map<number, { cost: number; level: number }>();
for (const t of trainers) {
  const rows = [...vm.all(`SELECT spell, spellcost, reqlevel FROM npc_trainer WHERE entry=? AND build_max>=5875`, t.entry),
    ...(Number(t.trainer_id) ? vm.all(`SELECT spell, spellcost, reqlevel FROM npc_trainer_template WHERE entry=? AND build_max>=5875`, Number(t.trainer_id)) : [])];
  for (const r of rows) offers.set(Number(r.spell), { cost: Number(r.spellcost), level: Number(r.reqlevel) });
}
const start = vm.all(`SELECT spell FROM playercreateinfo_spell WHERE class=? AND race=1`, cls).map(r => Number(r.spell));
console.log(`${trainers.length} trainers, ${offers.size} offers, ${start.length} starting spells`);
const rows: string[] = [];
for (const [teach, o] of offers) {
  if (o.level > maxLevel) continue;
  const t = vm.spell(teach);
  const real = t && Number(t.effect1) === 36 ? Number(t.effectTriggerSpell1) : teach;
  const s = vm.spell(real);
  if (!s) continue;
  const eff = [1, 2, 3].map(e => Number(s[`effect${e}`]) ? `e${s[`effect${e}`]}${Number(s[`effectApplyAuraName${e}`]) ? `/a${s[`effectApplyAuraName${e}`]}` : ''}:${Number(s[`effectBasePoints${e}`]) + 1}+d${s[`effectDieSides${e}`]}${Number(s[`effectRealPointsPerLevel${e}`]) ? `+${s[`effectRealPointsPerLevel${e}`]}/lv` : ''}${Number(s[`effectAmplitude${e}`]) ? ` amp${s[`effectAmplitude${e}`]}` : ''} m${s[`effectMiscValue${e}`]}` : '').filter(Boolean).join(' | ');
  rows.push(`L${String(o.level).padStart(2)} ${String(real).padStart(5)} ${String(s.name).padEnd(24)} ${String(s.nameSubtext ?? '').padEnd(8)} school${s.school} pow${s.powerType} cost${s.manaCost} cast${s.castingTimeIndex} cd${s.recoveryTime}/${s.categoryRecoveryTime} gcd${s.startRecoveryTime} dur${s.durationIndex} lvl${s.spellLevel}-${s.maxLevel} dmgcls${s.dmgClass} fam${s.spellFamilyName}:${s.spellFamilyFlags}  ${eff}`);
}
rows.sort();
for (const r of rows) console.log(r);
console.log('start:', start.map(id => `${id}:${vm.spell(id)?.name}`).join(', '));
