// On-demand art: the game asks for icons/<name>.png or creatures/<display>.json|.glb, and if it isn't
// in the cache yet it's converted from the player's own client right then and cached. With every
// zone in the world, converting all ~2,000 creature models up front would be over a gigabyte;
// on demand, a player only ever converts what they actually see.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { decodeBLP } from '../blp/blp.js';
import { encodePNG } from '../img/png.js';
import { convertCreature } from './creature.js';
import { convertItemArt, convertItemModel } from './items.js';
import { convertObject } from './objects.js';
import { convertSound } from './sounds.js';

export class LazyArt {
  private failed = new Set<string>();
  constructor(private client: Client, private cacheDir: string) {}

  /** The file at `rel` (relative to the cache), converting it first if it's a convertible asset. */
  get(rel: string): Buffer | null {
    rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.includes('..')) return null;
    const file = path.join(this.cacheDir, rel);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    if (this.failed.has(rel)) return null;
    try {
      if (this.convert(rel) && fs.existsSync(file)) return fs.readFileSync(file);
    } catch { /* fall through */ }
    this.failed.add(rel);
    return null;
  }

  private convert(rel: string): boolean {
    let m = rel.match(/^icons\/([\w-]+)\.png$/i);
    if (m) {
      const buf = this.client.archives.read(`Interface\\Icons\\${m[1]}.blp`);
      if (!buf) return false;
      fs.mkdirSync(path.join(this.cacheDir, 'icons'), { recursive: true });
      fs.writeFileSync(path.join(this.cacheDir, rel), encodePNG(decodeBLP(buf)));
      return true;
    }
    m = rel.match(/^creatures\/(\d+)\.(json|glb)$/);
    if (m) {
      convertCreature(this.client, Number(m[1]), this.cacheDir);
      return true;
    }
    // Sounds: sounds/<entry>.json lists its files; asking for a file converts its whole entry.
    m = rel.match(/^sounds\/(\d+)(?:\.json|-\d+\.(?:wav|mp3))$/);
    if (m) return convertSound(this.client, Number(m[1]), this.cacheDir);
    m = rel.match(/^objects\/(\d+)\.glb$/);
    if (m) return convertObject(this.client, Number(m[1]), this.cacheDir);
    // Equipped items: items/<display>.json, items/<display>-<left|right>[-<race><M|F>].glb
    m = rel.match(/^items\/(\d+)\.json$/);
    if (m) { convertItemArt(this.client, Number(m[1]), this.cacheDir); return true; }
    m = rel.match(/^items\/(\d+)-(left|right)(?:-(Hu|Or|Dw|Ni|Sc|Ta|Gn|Tr)([MF]))?\.glb$/);
    if (m) {
      const race = m[3] ? ({ Hu: 1, Or: 2, Dw: 3, Ni: 4, Sc: 5, Ta: 6, Gn: 7, Tr: 8 } as Record<string, number>)[m[3]] : null;
      return convertItemModel(this.client, Number(m[1]), m[2] as 'left' | 'right', race, (m[4] as 'M' | 'F') ?? null, this.cacheDir);
    }
    return false;
  }
}
