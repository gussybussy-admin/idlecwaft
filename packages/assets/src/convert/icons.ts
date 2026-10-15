// Converts Interface\Icons\<name>.blp to cache/icons/<name>.png for every icon the game data uses.
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import type { Client } from '../client.js';
import { decodeBLP } from '../blp/blp.js';
import { encodePNG } from '../img/png.js';

export function convertIcons(client: Client, data: GameData, cacheDir: string, extra: string[] = []): { written: number; missing: string[] } {
  const names = new Set<string>(extra);
  for (const it of Object.values(data.items)) names.add(it.icon);
  const out = path.join(cacheDir, 'icons');
  fs.mkdirSync(out, { recursive: true });
  let written = 0;
  const missing: string[] = [];
  for (const name of names) {
    const file = path.join(out, `${name.toLowerCase()}.png`);
    if (fs.existsSync(file)) continue;
    const buf = client.archives.read(`Interface\\Icons\\${name}.blp`);
    if (!buf) { missing.push(name); continue; }
    fs.writeFileSync(file, encodePNG(decodeBLP(buf)));
    written++;
  }
  return { written, missing };
}
