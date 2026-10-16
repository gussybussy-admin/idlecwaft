// Dev helper: runs dungeons with hireling groups (and groups missing a role) over many seeds.
//   tsx dungeon-balance.ts [dungeon name part] [runs]
import fs from 'node:fs';
import path from 'node:path';
import { groupRoles, hireling, simulateRun, type GameData, type Role } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const filter = process.argv[2] ?? '';
const runs = Number(process.argv[3] ?? 20);
const comps: Record<string, Role[]> = {
  'full (T/H/3D)': ['tank', 'healer', 'dps', 'dps', 'dps'],
  'no healer': ['tank', 'dps', 'dps', 'dps', 'dps'],
  'no tank': ['healer', 'dps', 'dps', 'dps', 'dps'],
};
for (const d of Object.values(data.dungeons).filter(x => x.name.includes(filter)).sort((a, b) => a.minLevel - b.minLevel)) {
  const level = Number(process.env.LEVEL) || Math.round((d.minLevel + d.maxLevel) / 2) - 2;
  for (const [label, roles] of Object.entries(comps)) {
    // Bigger groups: the standard tank/healer counts for their size (a missing role stays missing).
    const want = groupRoles(d.size);
    const full: Role[] = [...Array(want.tanks).fill('tank'), ...Array(want.healers).fill('healer')];
    while (full.length < d.size) full.push('dps');
    const group = (d.size > 5 ? full.filter(r => roles.includes(r)).concat(Array(d.size).fill('dps')).slice(0, d.size) : roles).map((r, i) => hireling(data, r, level, 'alliance', i, d.tier ?? 0));
    let clears = 0, mins = 0, prog = 0, items = 0;
    for (let s = 1; s <= runs; s++) {
      const r = simulateRun(data, d, group, s);
      if (r.cleared) clears++;
      mins += r.durationMs / 60000; prog += r.progress / d.encounters.length; items += r.loot.length;
    }
    console.log(`${d.name.padEnd(30)} L${level} ${label.padEnd(14)} clear ${String(Math.round(100 * clears / runs)).padStart(3)}%  progress ${Math.round(100 * prog / runs)}%  ~${Math.round(mins / runs)} min  ${(items / runs).toFixed(1)} items  dps ${group.map(g => g.dps).join('/')}`);
  }
}
