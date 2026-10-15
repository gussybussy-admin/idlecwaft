// Dev helper: which TaxiNodes column is the Alliance / Horde mount, and CharBaseInfo race/class pairs.
import { loadConfig } from '../config.js';
import { Client } from '../client.js';

const client = new Client(loadConfig().clientPath);
const t = client.dbc('TaxiNodes');
for (const r of t.rows()) {
  const name = t.str(r, 5);
  if (/Orgrimmar|Thunder Bluff|Undercity|Ironforge|Stormwind|Booty Bay|Ratchet|Crossroads|Darnassus|Gadgetzan/.test(name)) {
    console.log(`${String(t.u32(r, 0)).padStart(3)} map${t.u32(r, 1)} ${name.padEnd(36)} [14]=${t.u32(r, 14)} [15]=${t.u32(r, 15)}`);
  }
}
const cb = client.dbc('CharBaseInfo');
console.log(`CharBaseInfo recordSize=${cb.recordSize}:`, cb.rows().map(r => `${cb.u8(r, 0)}/${cb.u8(r, 1)}`).join(' '));
