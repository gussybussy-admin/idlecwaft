// Dev helper: one hireling run in detail — each pull's result, and for the first wipe what dealt the
// damage, who died when, and how much was healed.
//   tsx run-trace.ts "Molten Core" [level] [seed]
import fs from 'node:fs';
import path from 'node:path';
import { groupRoles, hireling, simulateRun, type GameData, type Role } from '@idle/sim';
import { loadConfig } from '../config.js';

const data: GameData = JSON.parse(fs.readFileSync(path.join(loadConfig().cacheDir, 'data/game.json'), 'utf8'));
const d = Object.values(data.dungeons).find(x => x.name === process.argv[2])!;
const level = Number(process.argv[3] ?? 60), seed = Number(process.argv[4] ?? 1);
const want = groupRoles(d.size);
const roles: Role[] = [...Array(want.tanks).fill('tank'), ...Array(want.healers).fill('healer')];
while (roles.length < d.size) roles.push('dps');
const g = roles.map((r, i) => hireling(data, r, level, 'alliance', i, d.tier ?? 0));
console.log(`${d.name}: ${g.length} members; tank hp ${g[0].maxHp} armor ${g[0].armor}; dps ${g.filter(x => x.role === 'dps').reduce((a, x) => a + x.dps, 0)} total`);
const r = simulateRun(data, d, g, seed);
const name = (id: number) => data.creatures[id]?.name ?? id;
let pullAt = 0, enc = -1;
for (const e of r.events) {
  if (e.k === 'pull') { pullAt = e.t; enc = e.enc; }
  if (e.k === 'clear' || e.k === 'wipe') console.log(`${e.k.padEnd(5)} ${String(enc).padStart(3)} ${((e.t - pullAt) / 1000).toFixed(0).padStart(4)}s ${d.encounters[enc].mobs.map(([c, n]) => `${n}x ${name(c)}`).join(', ')}`);
}
const wipeAt = r.events.findIndex(e => e.k === 'wipe');
if (wipeAt >= 0) {
  let p = wipeAt; while (p > 0 && r.events[p].k !== 'pull') p--;
  const start = r.events[p].t;
  const by = new Map<string, number>();
  const spellName = (id?: number) => Object.values(data.creatures).flatMap(c => c.abilities ?? []).find(a => a.spell === id)?.name ?? id;
  for (const e of r.events.slice(p, wipeAt)) {
    if (e.k === 'hit' && e.mob) { const k = e.spell ? `${spellName(e.spell)}` : e.src < 0 ? 'damage over time' : 'melee'; by.set(k, (by.get(k) ?? 0) + e.amt); }
    if (e.k === 'heal') by.set('(healed)', (by.get('(healed)') ?? 0) + e.amt);
    if (e.k === 'die' && !e.mob) by.set('(deaths)', (by.get('(deaths)') ?? 0) + 1);
    if (e.k === 'die' && !e.mob && e.who < want.tanks) console.log(`  tank ${e.who} dies at ${((e.t - start) / 1000).toFixed(0)}s`);
  }
  console.log('  first wipe:', [...by].map(([k, v]) => `${k} ${v}`).join(' | '));
}
