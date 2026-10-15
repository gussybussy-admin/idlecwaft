// Dev helper: summarize cache/data/game.json.
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
for (const z of data.zones) {
  console.log(`== ${z.name}`);
  for (const c of z.creatures) {
    const d = data.creatures[c.id], s = d.stats[0];
    console.log(`  ${String(c.id).padStart(6)} ${d.name.padEnd(28)} L${d.levelMin}-${d.levelMax} r${d.rank} t${d.type} x${c.spawns} hp${s.hp} dmg${s.dmgMin}-${s.dmgMax}/${d.attackMs}ms gold${d.goldMin}-${d.goldMax} loot=${d.loot ? d.loot.entries.length + '+' + d.loot.groups.length + 'g' : '-'} disp=${d.displayIds.join(',')}`);
  }
  for (const n of z.nodes) console.log(`  node ${data.nodes[n.id].name} (${data.nodes[n.id].skill} ${data.nodes[n.id].reqSkill}) x${n.spawns}`);
  const fish = z.fishing ? [...z.fishing.loot.entries, ...z.fishing.loot.groups.flat()] : [];
  console.log(`  fishing (zone skill ${z.fishing?.zoneSkill}): ${fish.map(e => 'item' in e ? `${data.items[e.item]?.name}:${e.chance}` : 'ref').join(', ')}`);
}
for (const r of Object.values(data.recipes)) {
  console.log(`recipe ${r.name}: ${r.reagents.map(([i, n]) => `${n}x ${data.items[i]?.name}`).join(' + ')} -> ${data.items[r.item]?.name} [${r.orange}/${r.yellow}/${r.green}/${r.grey}] ${'trainer' in r.source ? `trainer ${r.source.trainer}c` : `recipe item ${r.source.recipeItem}`}`);
}
for (const [skill, ranks] of Object.entries(data.skillRanks)) console.log(`ranks ${skill}: ${ranks.map(r => `${r.name} ${r.max} L${r.reqLevel} ${r.cost}c`).join(', ')}`);
const food = Object.values(data.items).filter(i => i.food).slice(0, 8);
console.log('food:', food.map(i => `${i.name} heal ${i.food!.heal}/${i.food!.durationMs}ms`).join('; '));
