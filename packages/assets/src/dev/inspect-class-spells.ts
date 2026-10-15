// Dev helper: what each class learns in game.json, by level.   tsx inspect-class-spells.ts [classId]
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const only = process.argv[2] ? Number(process.argv[2]) : null;
for (const c of data.classes) {
  if (only && c.id !== only) continue;
  const offers = data.classSpells[c.id] ?? [];
  if (!offers.length) continue;
  console.log(`== ${c.name}: ${offers.length} spell ranks; trainers in ${(data.classTrainerZones[c.id] ?? []).map(z => data.zones.find(x => x.id === z)?.name).join(', ')}`);
  for (const o of offers.filter(o => o.level <= (only ? 60 : 12))) {
    const s = data.spells[o.spell];
    console.log(`  L${String(o.level).padStart(2)} ${s.name} ${s.rank} [${s.power} ${s.cost}${s.castMs ? ` cast ${s.castMs}` : ''}${s.cooldownMs ? ` cd ${s.cooldownMs}` : ''}${s.nextSwing ? ' next-swing' : ''}${s.requires ? ` needs ${s.requires}` : ''}] ${s.effects.map(e => e.k).join('+')} ${o.cost ? o.cost + 'c' : ''}`);
  }
}
