// Dev helper: show each column of a DBC for a few rows, detecting string columns across all rows.
//   tsx sniff-dbc.ts SkillLine:0,20 Map:0,10
import { loadConfig } from '../config.js';
import { Client } from '../client.js';

const client = new Client(loadConfig().clientPath);
for (const arg of process.argv.slice(2)) {
  const [name, rowsArg] = arg.split(':');
  const d = client.dbc(name);
  const rows = (rowsArg ?? '0,1,2').split(',').map(Number).filter(r => r < d.records);
  console.log(`\n### ${name} records=${d.records} fields=${d.fields}`);
  for (let f = 0; f < d.fields; f++) {
    let isStr = d.stringSize > 1, any = false, allZero = true;
    for (let r = 0; r < d.records; r++) {
      const v = d.u32(r, f);
      if (v) { allZero = false; if (!d.isStringStart(v)) isStr = false; else any = true; }
    }
    if (allZero) continue;
    isStr &&= any;
    const cells = rows.map(r => {
      if (isStr) return JSON.stringify(d.str(r, f).slice(0, 48));
      const v = d.u32(r, f), fl = d.f32(r, f);
      if (v > 0x10000000 && Number.isFinite(fl) && Math.abs(fl) < 1e7 && Math.abs(fl) > 1e-4) return fl.toFixed(3) + 'f';
      return String(d.i32(r, f));
    });
    console.log(`  [${f}]${isStr ? 's' : ' '} ${cells.join(' | ')}`);
  }
}
client.close();
