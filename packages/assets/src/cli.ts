#!/usr/bin/env -S npx tsx
// idle-assets: converts assets from YOUR OWN local WoW 1.12.1 client into a local cache.
// Nothing here downloads or uploads game data.
import { loadConfig } from './config.js';
import { Client } from './client.js';
import { convertCreature } from './convert/creature.js';
import { printRecon } from './recon.js';

const USAGE = `usage: idle-assets [--client <path>] [--cache <dir>] <command>

commands:
  recon                     inventory the client: archives, DBC counts
  find-creature <text>      list creature displays whose model path contains <text>
  creature <displayId...>   convert creature displays to cache/creatures/<id>.glb`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const clientPath = flag('--client'), cacheDir = flag('--cache');
const [cmd, ...rest] = args;
if (!cmd) { console.log(USAGE); process.exit(1); }

const cfg = loadConfig({ ...(clientPath ? { clientPath } : {}), ...(cacheDir ? { cacheDir } : {}) });
const client = new Client(cfg.clientPath);
try {
  switch (cmd) {
    case 'recon':
      printRecon(client);
      break;
    case 'find-creature': {
      const q = (rest[0] ?? '').toLowerCase();
      for (const d of client.creatureDisplays().values()) {
        if (d.modelPath.toLowerCase().includes(q)) {
          console.log(`${String(d.id).padStart(6)}  ${d.modelPath}  skins=${d.skins.filter(Boolean).join(',') || '-'}${d.extraId ? '  (humanoid)' : ''}`);
        }
      }
      break;
    }
    case 'creature':
      for (const id of rest.map(Number)) {
        const t0 = Date.now();
        const e = convertCreature(client, id, cfg.cacheDir);
        console.log(`display ${id}: ${e.model} -> ${e.file} (${(e.bytes / 1024).toFixed(0)} KB, ${e.animations} anims, ${Date.now() - t0} ms)`);
      }
      break;
    default:
      console.log(USAGE); process.exitCode = 1;
  }
} finally {
  client.close();
}
