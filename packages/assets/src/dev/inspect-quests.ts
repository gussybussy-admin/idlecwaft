// Dev helper: quests per zone in game.json; with a zone name, the zone's quests in detail.
//   tsx inspect-quests.ts ["Elwynn Forest"]
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const qs = Object.values(data.quests);
const only = process.argv[2];
const byZone = new Map<number, number>();
for (const q of qs) byZone.set(q.zone, (byZone.get(q.zone) ?? 0) + 1);
console.log(`${qs.length} quests; kill ${qs.filter(q => q.kills.length).length}, collect ${qs.filter(q => q.items.length).length}, tasks ${qs.filter(q => q.task).length}, chains ${qs.filter(q => q.prev).length}`);
console.log(`factions: ${Object.values(data.factions).map(f => f.name).join(', ')}`);
console.log(`rep-gated items: ${Object.values(data.items).filter(i => i.reqRep).length}, creatures with kill rep: ${Object.values(data.creatures).filter(c => c.rep).length}`);
if (!only) {
  for (const z of data.zones) console.log(`  ${z.name.padEnd(24)} ${byZone.get(z.id) ?? 0}`);
} else {
  const z = data.zones.find(x => x.name === only)!;
  for (const q of qs.filter(x => x.zone === z.id).sort((a, b) => a.level - b.level).slice(0, 40)) {
    const obj = [
      ...q.kills.map(([c, n]) => `kill ${n} ${data.creatures[c]?.name}`),
      ...q.items.map(([i, n]) => `${n} ${data.items[i]?.name}`),
      ...(q.task ? [`task "${q.task.label}" ${Math.round(q.task.ms / 1000)}s`] : []),
    ].join(', ');
    console.log(`  [${q.level}] ${q.name.padEnd(32)} ${q.sides.join('/').padEnd(14)} ${obj} | ${q.xp}xp ${q.rep.map(([f, v]) => `${data.factions[f]?.name ?? f}+${v}`).join(' ')}${q.prev ? ` (after ${data.quests[q.prev]?.name})` : ''}${q.endZone !== q.zone ? ` -> ${data.zones.find(x => x.id === q.endZone)?.name}` : ''}`);
  }
}
