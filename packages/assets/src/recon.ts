// Phase 0 recon: archive inventory and content counts from the DBCs (column layouts verified against 5875).
import type { Client } from './client.js';

export function printRecon(client: Client): void {
  for (const { name, mpq } of client.archives.archives) {
    console.log(`${name.padEnd(16)} v${mpq.formatVersion} files=${mpq.fileCount}`);
  }

  const cat = client.dbc('SkillLineCategory');
  const catName = new Map(cat.rows().map(r => [cat.u32(r, 0), cat.str(r, 1)]));
  const sl = client.dbc('SkillLine'); // 0 id, 1 category, 3 name
  const byCat = new Map<string, string[]>();
  for (const r of sl.rows()) {
    const c = catName.get(sl.u32(r, 1)) ?? String(sl.u32(r, 1));
    byCat.set(c, [...(byCat.get(c) ?? []), sl.str(r, 3)]);
  }
  console.log(`\nSkillLine: ${sl.records}`);
  for (const [c, list] of byCat) console.log(`  ${c} (${list.length}): ${list.join(', ')}`);

  const tt = client.dbc('TalentTab'), ta = client.dbc('Talent'); // tab: 0 id, 1 name, 12 classMask; talent: 1 tab
  console.log(`\nTalents: ${ta.records} in ${tt.records} trees`);

  const fa = client.dbc('Faction'); // 1 reputationIndex, 19 name
  console.log(`Factions: ${fa.records}, with player reputation: ${fa.rows().filter(r => fa.i32(r, 1) >= 0).length}`);

  const mp = client.dbc('Map'); // 2 instanceType, 4 name
  const types = ['world', 'dungeon', 'raid', 'battleground'];
  for (let t = 0; t < 4; t++) {
    const names = mp.rows().filter(r => mp.u32(r, 2) === t).map(r => mp.str(r, 4));
    console.log(`Maps ${types[t]} (${names.length}): ${names.join(', ')}`);
  }

  for (const n of ['Spell', 'SkillLineAbility', 'CreatureDisplayInfo', 'CreatureModelData', 'ItemDisplayInfo',
    'AreaTable', 'TaxiNodes', 'AnimationData']) console.log(`${n}: ${client.dbc(n).records}`);

  const all = client.archives.list();
  const ext = (e: string) => all.filter(f => f.endsWith(e)).length;
  console.log(`\nFiles: ${all.length} (m2 ${ext('.m2')}, blp ${ext('.blp')}, wmo ${ext('.wmo')}, adt ${ext('.adt')}, wav ${ext('.wav')})`);
}
