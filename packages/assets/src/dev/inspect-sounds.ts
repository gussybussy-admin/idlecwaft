// Dev helper: prints the layout of the client's sound tables (a few rows each, ints and strings).
//   tsx inspect-sounds.ts [Table ...]
import { Client } from '../client.js';
import { loadConfig } from '../config.js';

const client = new Client(loadConfig().clientPath);
const tables = process.argv.slice(2).length ? process.argv.slice(2)
  : ['SoundEntries', 'ZoneMusic', 'SoundAmbience', 'CreatureSoundData', 'SpellVisualKit', 'SpellVisual', 'WeaponImpactSounds', 'WeaponSwingSounds2', 'ZoneIntroMusicTable'];
for (const name of tables) {
  let d;
  try { d = client.dbc(name); } catch { console.log(`${name}: missing`); continue; }
  console.log(`== ${name}: ${d.records} rows, ${d.fields} fields`);
  for (const r of d.rows().slice(1, 4)) {
    const cells: string[] = [];
    for (let f = 0; f < d.fields; f++) {
      const v = d.u32(r, f);
      let s = '';
      try { s = v > 0 && v < d.stringSize ? d.str(r, f) : ''; } catch { /* not a string */ }
      cells.push(`${f}:${s && /^[\x20-\x7e]{2,}$/.test(s) ? JSON.stringify(s) : v > 1e9 ? d.f32(r, f).toFixed(2) : v}`);
    }
    console.log('  ' + cells.join(' '));
  }
}
client.close();
