// Dev helper: sanity-check the raw data the profession importer relies on.
//   tsx check-professions.ts
import { loadConfig } from '../config.js';
import { Client } from '../client.js';
import { VMangos } from '../import/vmangos.js';

const cfg = loadConfig();
const client = new Client(cfg.clientPath);
const vm = VMangos.open(process.cwd());
const RANKS: Record<string, number[]> = {
  alchemy: [2259, 3101, 3464, 11611], blacksmithing: [2018, 3100, 3538, 9785], enchanting: [7411, 7412, 7413, 13920],
  engineering: [4036, 4037, 4038, 12656], leatherworking: [2108, 3104, 3811, 10662], tailoring: [3908, 3909, 3910, 12180],
  firstaid: [3273, 3274, 7924, 10846], skinning: [8613, 8617, 8618, 10768],
};
for (const [k, ids] of Object.entries(RANKS)) console.log(k, ids.map(id => `${id}:${vm.spell(id)?.name}/${vm.trainerOffer(id)?.cost ?? '-'}`).join(' '));

const cols = (t: string) => vm.all(`PRAGMA table_info(${t})`).map(r => String(r.name));
console.log('creature_template skin cols', cols('creature_template').filter(c => /skin/.test(c)));
console.log('item_template de cols', cols('item_template').filter(c => /disench|item_level/.test(c)));
console.log('spell_template tool cols', cols('spell_template').filter(c => /totem|focus|equippedItem/i.test(c)));
console.log('loot tables', vm.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%loot%'`).map(r => r.name));

// Enchant recipe sample: Enchant Bracer - Minor Health (7418) and Enchant Chest - Minor Stats (13626)
for (const id of [7418, 13626, 7745]) {
  const s = vm.spell(id)!;
  console.log(id, s.name, 'eff', s.effect1, 'misc', s.effectMiscValue1, 'itemClass', s.equippedItemClass, 'invMask', s.equippedItemInventoryTypeMask, 'totem', s.totem1, s.totem2);
}
// Smelt Copper, a blacksmithing and an engineering recipe: tools
for (const id of [2657, 2660, 3918]) { const s = vm.spell(id)!; console.log(id, s.name, 'totem', s.totem1, s.totem2, 'focus', s.requiresSpellFocus); }
const sie = client.dbc('SpellItemEnchantment');
console.log('SpellItemEnchantment fields', sie.fields);
for (const r of sie.rows().slice(0, 400)) {
  const id = sie.u32(r, 0);
  if (![41, 66, 241, 847, 255, 723].includes(id)) continue;
  const raw = Array.from({ length: sie.fields }, (_, f) => sie.i32(r, f));
  console.log(id, raw.slice(0, 13).join(','), '|', sie.str(r, 13));
}
client.close();
vm.close();
