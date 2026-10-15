#!/usr/bin/env -S npx tsx
// idle-assets: converts assets from YOUR OWN local WoW 1.12.1 client into a local cache.
// Nothing here downloads or uploads game data.
import { loadConfig } from './config.js';
import { Client } from './client.js';
import { convertCreature } from './convert/creature.js';
import { printRecon } from './recon.js';
import { findRepoRoot } from './config.js';
import { buildGameData } from './import/build-game-data.js';
import { convertIcons } from './convert/icons.js';
import { convertUiAssets, UI_ICONS } from './convert/ui-assets.js';
import { convertCharacters } from './convert/characters.js';

const USAGE = `usage: idle-assets [--client <path>] [--cache <dir>] <command>

commands:
  recon                     inventory the client: archives, DBC counts
  find-creature <text>      list creature displays whose model path contains <text>
  creature <displayId...>   convert creature displays to cache/creatures/<id>.glb
  import [zoneId...]        build cache/data/game.json from the client + VMaNGOS DB (default: 12 Elwynn)
                            and convert the icons and creature models it needs`;

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
    case 'import': {
      const zones = rest.length ? rest.map(Number) : [12];
      const t0 = Date.now();
      const data = buildGameData(client, { zones, cacheDir: cfg.cacheDir, repoRoot: findRepoRoot(), log: s => console.log(s) });
      for (const z of data.zones) {
        console.log(`${z.name} (${z.levelMin}-${z.levelMax}): ${z.creatures.length} creatures, ${z.nodes.length} node types, fishing ${z.fishing ? `yes (zone skill ${z.fishing.zoneSkill})` : 'no'}, ${z.vendorItems.length} vendor items`);
      }
      console.log(`items ${Object.keys(data.items).length}, recipes ${Object.keys(data.recipes).length} -> cache/data/game.json (${Date.now() - t0} ms)`);
      const icons = convertIcons(client, data, cfg.cacheDir, UI_ICONS);
      convertUiAssets(client, cfg.cacheDir, s => console.log(s));
      console.log(`icons: ${icons.written} written${icons.missing.length ? `, missing: ${icons.missing.join(', ')}` : ''}`);
      convertCharacters(client, cfg.cacheDir, [1, 2, 3, 4, 5, 6, 7, 8], s => console.log(s));
      const displays = new Set<number>();
      for (const z of data.zones) for (const c of z.creatures) for (const d of data.creatures[c.id].displayIds) displays.add(d);
      let ok = 0; const skipped: string[] = [];
      for (const id of displays) {
        try { convertCreature(client, id, cfg.cacheDir); ok++; } catch (e) { skipped.push(`${id} (${(e as Error).message.split(':')[0]})`); }
      }
      console.log(`creature models: ${ok} converted, ${skipped.length} skipped`);
      if (skipped.length) console.log(`  skipped: ${skipped.slice(0, 12).join('; ')}${skipped.length > 12 ? ' …' : ''}`);
      break;
    }
    default:
      console.log(USAGE); process.exitCode = 1;
  }
} finally {
  client.close();
}
