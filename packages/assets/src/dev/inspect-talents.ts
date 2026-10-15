// Dev helper: talent trees in game.json with how many have an effect the idle fight uses.
//   tsx inspect-talents.ts [classId]
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const only = process.argv[2] ? Number(process.argv[2]) : null;
let all = 0, live = 0;
for (const tab of Object.values(data.talentTabs).sort((a, b) => a.cls - b.cls || a.order - b.order)) {
  const ts = Object.values(data.talents).filter(t => t.tab === tab.id);
  const withFx = ts.filter(t => t.effects.some(e => e.length));
  all += ts.length; live += withFx.length;
  console.log(`${data.classes.find(c => c.id === tab.cls)?.name?.padEnd(8)} ${tab.name.padEnd(16)} ${ts.length} talents, ${withFx.length} with effects`);
  if (only === tab.cls) for (const t of ts.sort((a, b) => a.row - b.row || a.col - b.col)) {
    console.log(`   r${t.row}c${t.col} ${t.name.padEnd(28)} ${t.ranks.length}r ${JSON.stringify(t.effects[t.ranks.length - 1]).slice(0, 110)}`);
  }
}
console.log(`total ${all} talents, ${live} with an effect the idle fight applies`);
