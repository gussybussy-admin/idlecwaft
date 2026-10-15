// Dev helper: recipes per profession in game.json, with trainer vs recipe-item counts and samples.
//   tsx inspect-professions.ts [skill]
import fs from 'node:fs';
import path from 'node:path';
import { PROFESSIONS, type GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const only = process.argv[2];
const recipes = Object.values(data.recipes);
for (const p of PROFESSIONS) {
  const rs = recipes.filter(r => r.skill === p);
  if (!rs.length) { console.log(`${p.padEnd(15)} -`); continue; }
  const trained = rs.filter(r => 'trainer' in r.source).length, starter = rs.filter(r => 'trainer' in r.source && !r.source.trainer).length;
  const top = Math.max(...rs.map(r => r.grey));
  console.log(`${p.padEnd(15)} ${String(rs.length).padStart(4)} recipes (${trained} trainer, ${starter} free, ${rs.length - trained} from recipes), up to skill ${top}, ranks ${data.skillRanks[p].map(r => r.cost).join('/')}`);
  if (only === p) for (const r of rs.sort((a, b) => a.orange - b.orange).slice(0, 25)) {
    console.log(`    ${String(r.orange).padStart(3)} ${r.name.padEnd(36)} -> ${r.item ? data.items[r.item]?.name : `enchant ${data.enchants[r.enchant!.id]?.name}`} | ${r.reagents.map(([i, n]) => `${n}x ${data.items[i]?.name}`).join(', ')}${r.tools ? ` | tools ${r.tools.map(t => data.items[t]?.name).join(', ')}` : ''}`);
  }
}
const skins = Object.values(data.creatures).filter(c => c.skin).length;
const de = Object.values(data.items).filter(i => i.disenchant).length;
const pots = Object.values(data.items).filter(i => i.potion).map(i => `${i.name} ${i.potion!.heal}/${i.potion!.mana}`);
const bandages = Object.values(data.items).filter(i => /Bandage/.test(i.name)).map(i => `${i.name} ${i.food?.heal}`);
console.log(`skinnable creatures ${skins}, disenchantable items ${de}, enchantments ${Object.keys(data.enchants).length}`);
console.log('potions:', pots.slice(0, 8).join('; '));
console.log('bandages:', bandages.join('; '));
console.log('sample enchants:', Object.values(data.enchants).slice(0, 6).map(e => JSON.stringify(e)).join('\n  '));
