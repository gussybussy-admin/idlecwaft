// Dev helper: instance maps (Map.dbc) and LFG dungeon entries (LFGDungeons.dbc) with spawn counts.
import { loadConfig } from '../config.js';
import { Client } from '../client.js';
import { VMangos } from '../import/vmangos.js';
const c = new Client(loadConfig().clientPath);
const vm = VMangos.open(process.cwd());
const map = c.dbc('Map');
for (const r of map.rows()) {
  const type = map.u32(r, 2);
  if (type !== 1 && type !== 2) continue;
  const id = map.u32(r, 0);
  const n = vm.get(`SELECT COUNT(*) n FROM creature WHERE map=? AND patch_min<=10`, id)?.n;
  console.log(`map ${id} type ${type} ${map.str(r, 4)} spawns=${n}`);
}
const lfg = c.dbc('LFGDungeons');
for (const r of lfg.rows()) if (lfg.u32(r, 12) !== 4) console.log(`lfg ${lfg.u32(r, 0)} type ${lfg.u32(r, 12)} ${lfg.str(r, 1)} ${lfg.u32(r, 10)}-${lfg.u32(r, 11)}`);
c.close(); vm.close();
