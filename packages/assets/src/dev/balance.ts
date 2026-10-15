// Dev helper: balance check against the real game data. Every class (human or orc start) fights its
// starting zone's easiest common mob for N minutes with 50 starter food; prints kills, deaths, level,
// and which spells the rotation actually used.   tsx balance.ts [minutes]
import fs from 'node:fs';
import path from 'node:path';
import { advance, newGame, startAction, type GameData, type SimEvent } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const minutes = Number(process.argv[2] ?? 60);
const T0 = 1_800_000_000_000;
for (const cls of data.classes) {
  const race = [1, 3, 4, 7, 2, 5, 6, 8].find(r => data.raceClasses[r]?.includes(cls.id));
  if (!race) continue;
  const s = newGame(data, { name: 'Bal', race, cls: cls.id, seed: 7, now: T0 });
  const zone = data.zones.find(z => z.id === s.zone)!;
  const target = zone.creatures.map(c => data.creatures[c.id]).find(c => c.rank === 0 && c.levelMin <= 2 && c.hostile.length === 2)!;
  s.inventory[117] = 50; // Tough Jerky
  const used = new Map<string, number>();
  startAction(s, data, { kind: 'fight', creature: target.id });
  advance(s, data, T0 + minutes * 60_000, (e: SimEvent) => {
    if (e.type === 'swing' && e.who === 'player' && e.spell) { const n = data.spells[e.spell]?.name ?? String(e.spell); used.set(n, (used.get(n) ?? 0) + 1); }
    if (e.type === 'heal') { const n = data.spells[e.spell]?.name ?? 'heal'; used.set(n, (used.get(n) ?? 0) + 1); }
  });
  const kills = Object.values(s.stats.kills).reduce((a, b) => a + b, 0);
  console.log(`${cls.name.padEnd(8)} ${data.races.find(r => r.id === race)!.name.padEnd(9)} vs ${target.name.padEnd(16)} kills ${String(kills).padStart(3)} deaths ${s.stats.deaths} level ${s.char.level} food left ${s.inventory[117] ?? 0}  | ${[...used].map(([n, c]) => `${n} x${c}`).join(', ') || 'melee only'}`);
}
