// Dev helper: dungeons in game.json with their run order; a name shows that dungeon in detail.
//   tsx inspect-dungeons.ts ["Deadmines"]
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const only = process.argv[2];
for (const d of Object.values(data.dungeons).sort((a, b) => a.minLevel - b.minLevel)) {
  const bosses = d.encounters.filter(e => e.boss).map(e => data.creatures[e.boss!]?.name);
  console.log(`${d.name.padEnd(30)} ${d.minLevel}-${d.maxLevel} x${d.size} ${data.zones.find(z => z.id === d.zone)?.name ?? '?'} | ${d.encounters.length} pulls | ${bosses.join(', ')}`);
  if (only && d.name.includes(only)) {
    for (const e of d.encounters) {
      const mobs = e.mobs.map(([c, n]) => `${n}x ${data.creatures[c]?.name} L${data.creatures[c]?.levelMax}${data.creatures[c]?.rank ? '+' : ''}`).join(', ');
      const ab = e.boss ? (data.creatures[e.boss]?.abilities ?? []).map(a => `${a.name}[${a.target}${a.aoe ? ',aoe' : ''}:${a.effects.map(x => x.k).join('/')}]`).join(' ') : '';
      console.log(`    ${e.boss ? 'BOSS' : 'pull'} ${mobs} ${ab}`);
    }
  }
}
const quests = Object.values(data.quests).filter(q => q.kills.some(([c]) => Object.values(data.dungeons).some(d => d.encounters.some(e => e.mobs.some(([m]) => m === c)))));
console.log(`dungeon quests (kill objectives inside): ${quests.length}`);
