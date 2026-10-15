// Dev helper: what the quest/reputation importer can work with.
//   tsx check-quests.ts
import { loadConfig } from '../config.js';
import { Client } from '../client.js';
import { VMangos } from '../import/vmangos.js';

const client = new Client(loadConfig().clientPath);
const vm = VMangos.open(process.cwd());
const cols = (t: string) => vm.all(`PRAGMA table_info(${t})`).map(r => String(r.name));
console.log('tables', vm.all(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%quest%' OR name LIKE '%reput%' OR name LIKE '%faction%')`).map(r => r.name).join(', '));
console.log('quest_template cols', cols('quest_template').join(' '));
console.log('onkill rep cols', cols('creature_onkill_reputation').join(' '));
console.log('quest rows', vm.get(`SELECT COUNT(*) n FROM quest_template WHERE patch<=10`)?.n);
for (const id of [783, 7, 33, 5261, 2158]) {
  const q = vm.get(`SELECT * FROM quest_template WHERE entry=? ORDER BY patch DESC LIMIT 1`, id);
  if (!q) continue;
  const pick = Object.fromEntries(Object.entries(q).filter(([k, v]) => v && v !== '0' && !/^(Details|Objectives|OfferRewardText|RequestItemsText|EndText|CompletedText|ObjectiveText\d)$/i.test(k)));
  console.log(id, JSON.stringify(pick).slice(0, 900));
}
const fac = client.dbc('Faction');
console.log('Faction fields', fac.fields);
for (const r of fac.rows().slice(0, 400)) {
  const id = fac.u32(r, 0);
  if (![72, 47, 69, 54, 76, 68, 81, 530, 21, 87, 92].includes(id)) continue;
  console.log(id, Array.from({ length: 19 }, (_, f) => fac.i32(r, f)).join(','), '|', fac.str(r, 19));
}
client.close();
vm.close();
