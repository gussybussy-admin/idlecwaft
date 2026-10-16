// Dev helper: leveling pace. A character of each class at a few levels, in hireling-style gear with
// its trainer spells and plenty of food, fights an at-level mob for 4 simulated hours.
//   tsx pace.ts [levels...]
import fs from 'node:fs';
import path from 'node:path';
import { advance, hirelingGear, newGame, playerStats, startAction, type GameData, type Slot } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const levels = process.argv.slice(2).map(Number).filter(Boolean);
const HOURS = 4;
const food = Object.values(data.items).filter(i => i.food).sort((a, b) => a.reqLevel - b.reqLevel);
for (const level of levels.length ? levels : [3, 10, 20, 30, 45, 58]) {
  const row: string[] = [];
  for (const [cls, race] of (process.env.CLASSES ?? '1:1,8:1,5:1,4:1').split(',').map(x => x.split(':').map(Number))) {
    const s = newGame(data, { name: 'Pace', race, cls, seed: 7, now: 0 });
    s.char.level = level;
    s.spells = (data.classSpells[cls] ?? []).filter(o => o.level <= level).map(o => o.spell);
    for (const [slot, id] of Object.entries(hirelingGear(data, cls, cls === 1 ? 'dps' : cls === 5 ? 'healer' : 'dps', level))) s.equipment[slot as Slot] = id;
    if (cls === 3) {
      // A bow of your level, a stack of arrows, and a tamed beast.
      const bow = Object.values(data.items).filter(i => i.class === 2 && i.subclass === 2 && i.reqLevel <= level && i.quality <= 3).sort((a, b) => (b.dmgMax + b.dmgMin) / b.delayMs - (a.dmgMax + a.dmgMin) / a.delayMs)[0];
      if (bow) s.equipment.ranged = bow.id;
      const arrows = Object.values(data.items).filter(i => i.class === 6 && i.subclass === 2 && i.reqLevel <= level).sort((a, b) => b.dmgMax - a.dmgMax)[0];
      if (arrows) s.inventory[arrows.id] = 5000;
      if (level >= 10 && process.env.NOPET !== '1') s.pet = { kind: 'beast', name: 'Wolf', displayId: 0 };
    }
    const f = [...food].reverse().find(i => i.reqLevel <= level);
    if (f) s.inventory[f.id] = 500;
    // An at-level, common mob somewhere in the world.
    const mob = Object.values(data.creatures).find(c => c.rank === 0 && c.levelMin === level && !c.abilities?.length && c.type === 1 && data.zones.some(z => z.creatures.some(x => x.id === c.id)))
      ?? Object.values(data.creatures).find(c => c.rank === 0 && c.levelMin <= level && c.levelMax >= level)!;
    s.zone = data.zones.find(z => z.creatures.some(x => x.id === mob.id))?.id ?? s.zone;
    s.char.hp = playerStats(s, data).maxHp;
    startAction(s, data, { kind: 'fight', creature: mob.id });
    // Count until the first level-up (rates are per hour at this level).
    let kills = 0, xp = 0, until = HOURS * 3_600_000;
    advance(s, data, HOURS * 3_600_000, e => { if (until < HOURS * 3_600_000) return; if (e.type === 'kill') { kills++; xp += e.xp; } if (e.type === 'levelup') until = e.t; });
    const hours = until / 3_600_000;
    row.push(`${data.classes.find(c => c.id === cls)!.name.slice(0, 7).padEnd(7)} ${String(Math.round(kills / hours)).padStart(4)} kills/h ${String(Math.round(xp / hours)).padStart(6)} xp/h ${(data.xpToNext[level] / Math.max(1, xp / hours)).toFixed(1).padStart(5)} h/level`);
  }
  console.log(`L${String(level).padStart(2)}  ` + row.join(' | '));
}
