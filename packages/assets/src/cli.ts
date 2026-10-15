#!/usr/bin/env -S npx tsx
// idle-assets: converts assets from YOUR OWN local WoW 1.12.1 client into a local cache.
// The only network access is `art --server`, which downloads the game's data list (names, stats,
// which models and icons exist) from your guild server. No game art is downloaded or uploaded.
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { findRepoRoot, loadConfig } from './config.js';
import { Client } from './client.js';
import { convertCreature } from './convert/creature.js';
import { printRecon } from './recon.js';
import { buildGameData } from './import/build-game-data.js';
import { convertArt } from './convert/art.js';

const USAGE = `usage: idle-assets [--client <path>] [--cache <dir>] <command>

commands:
  art --server <url> [--all] (players) convert the art the game needs up front (creature models and item
                            icons otherwise convert on demand while playing; --all converts everything now)
  import [zoneId...]        (server host) build cache/data/game.json from the client + VMaNGOS DB
                            (default: 12 Elwynn), then convert the art it needs
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
const clientPath = flag('--client'), cacheDir = flag('--cache'), server = flag('--server');
const allArt = args.includes('--all') ? (args.splice(args.indexOf('--all'), 1), true) : false;
const [cmd, ...rest] = args;
if (!cmd) { console.log(USAGE); process.exit(1); }

async function main() {
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
          const e = convertCreature(client, id, cfg.cacheDir);
          console.log(`display ${id}: ${e.model} -> ${e.file || '(humanoid, assembled at runtime)'}`);
        }
        break;
      case 'import': {
        const zones = rest.map(Number); // empty: every zone
        const data = buildGameData(client, { zones, cacheDir: cfg.cacheDir, repoRoot: findRepoRoot(), log: s => console.log(s) });
        for (const z of data.zones) {
          console.log(`${z.name} (${z.levelMin}-${z.levelMax}): ${z.creatures.length} creatures, ${z.nodes.length} node types, fishing ${z.fishing ? `yes (zone skill ${z.fishing.zoneSkill})` : 'no'}, ${z.vendorItems.length} vendor items`);
        }
        console.log(`items ${Object.keys(data.items).length}, recipes ${Object.keys(data.recipes).length} -> cache/data/game.json`);
        convertArt(client, data, cfg.cacheDir, console.log, allArt);
        break;
      }
      case 'art': {
        if (!server) { console.log('art needs --server <url>, e.g. --server http://100.101.102.103:7420'); process.exitCode = 1; break; }
        const url = server.replace(/\/+$/, '') + '/api/gamedata';
        console.log(`fetching the world's data list from ${url}`);
        const res = await fetch(url).catch(e => { throw new Error(`can't reach ${url}: ${(e as Error).message}`); });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const text = await res.text();
        const data = JSON.parse(text) as GameData;
        fs.mkdirSync(path.join(cfg.cacheDir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(cfg.cacheDir, 'data/game.json'), text);
        console.log(`world: ${data.zones.map(z => z.name).join(', ')}; ${Object.keys(data.items).length} items`);
        convertArt(client, data, cfg.cacheDir, console.log, allArt);
        break;
      }
      default:
        console.log(USAGE); process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

main().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
