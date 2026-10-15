// Dev helper: search the merged client listfile.  tsx find-files.ts <substring> [limit]
import { loadConfig } from '../config.js';
import { Client } from '../client.js';

const client = new Client(loadConfig().clientPath);
const q = (process.argv[2] ?? '').toLowerCase(), limit = Number(process.argv[3] ?? 40);
const hits = client.archives.list(n => n.includes(q));
console.log(`${hits.length} hits`);
for (const h of hits.slice(0, limit)) console.log('  ' + h);
