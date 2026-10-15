// Dev helper: which weapon/armor skills each class may learn, per SkillRaceClassInfo.
import { loadConfig } from '../config.js';
import { Client } from '../client.js';

const client = new Client(loadConfig().clientPath);
const sl = client.dbc('SkillLine');
const names = new Map(sl.rows().filter(r => [6, 8].includes(sl.u32(r, 1))).map(r => [sl.u32(r, 0), sl.str(r, 3)]));
const srci = client.dbc('SkillRaceClassInfo');
const cls = client.dbc('ChrClasses');
for (const c of cls.rows()) {
  const id = cls.u32(c, 0), bit = 1 << (id - 1);
  const skills = srci.rows().filter(r => names.has(srci.u32(r, 1)) && srci.u32(r, 3) & bit).map(r => `${names.get(srci.u32(r, 1))}${srci.u32(r, 5) ? `@${srci.u32(r, 5)}` : ''}(f${srci.u32(r, 4).toString(16)})`);
  console.log(`${cls.str(c, 5).padEnd(8)} ${[...new Set(skills)].join(', ')}`);
}
