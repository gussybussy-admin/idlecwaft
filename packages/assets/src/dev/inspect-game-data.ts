// Dev helper: summarize cache/data/game.json.   tsx inspect-game-data.ts [zone name filter]
import fs from 'node:fs';
import path from 'node:path';
import type { GameData, LootRef } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const filter = (process.argv[2] ?? '').toLowerCase();
const lootSize = (k: LootRef | null) => { const t = k ? data.loot[k] : null; return t ? `${t.entries.length}+${t.groups.length}g` : '-'; };
console.log(`${data.zones.length} zones, ${Object.keys(data.creatures).length} creatures, ${Object.keys(data.items).length} items, ${Object.keys(data.loot).length} loot tables, ${Object.keys(data.taxiNodes).length} flight nodes`);
for (const z of data.zones) {
  if (filter && !z.name.toLowerCase().includes(filter)) {
    if (!filter) continue;
    continue;
  }
  console.log(`== ${z.name} (map ${z.map}, ${z.levelMin}-${z.levelMax}${z.city ? ', city' : ''}) at ${z.x},${z.y}: ${z.creatures.length} creatures, ${z.nodes.length} nodes, ${z.vendorItems.length} vendor items, taxi ${z.taxiNodes.map(t => data.taxiNodes[t].name).join('; ')}`);
  for (const c of z.creatures.slice(0, 60)) {
    const d = data.creatures[c.id], s = d.stats[0];
    console.log(`  ${String(c.id).padStart(6)} ${d.name.padEnd(28)} L${d.levelMin}-${d.levelMax} r${d.rank} x${c.spawns} hp${s.hp} dmg${s.dmgMin}-${s.dmgMax} hostile=${d.hostile.join('/')} loot=${lootSize(d.loot)}`);
  }
  for (const n of z.nodes) console.log(`  node ${data.nodes[n.id].name} (${data.nodes[n.id].skill} ${data.nodes[n.id].reqSkill}) x${n.spawns}`);
}
if (!filter) process.exit(0);
console.log('races', data.races.map(r => `${r.name}:${r.faction}:start ${data.zones.find(z => z.id === data.startZones[r.id])?.name}:classes ${data.raceClasses[r.id]}`).join(' | '));
