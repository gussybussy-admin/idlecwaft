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
    return false;
  }
}
