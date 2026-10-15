// Dev helper: print table schemas and row counts from the VMaNGOS world SQLite.
//   tsx inspect-vmangos.ts [table ...]     (no args: list all tables with row counts)
import Database from 'better-sqlite3';
import path from 'node:path';
import { findRepoRoot } from '../config.js';

const db = new Database(path.join(findRepoRoot(), 'data/vmangos/db/sqlite-dump/mangos.sqlite'), { readonly: true });
const tables = process.argv.slice(2);
if (!tables.length) {
  const all = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
  for (const { name } of all) {
    const { n } = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get() as { n: number };
    if (n) console.log(`${name.padEnd(40)} ${n}`);
  }
} else for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string; type: string }[];
  console.log(`\n## ${t}: ${cols.map(c => c.name).join(', ')}`);
  for (const r of db.prepare(`SELECT * FROM "${t}" LIMIT 2`).all()) console.log(JSON.stringify(r).slice(0, 600));
}
