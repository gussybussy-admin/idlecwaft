// Game-object models (GameObjectDisplayInfo): ore veins, herbs, campfires, anvils, the fishing bobber.
// Converted on demand into cache/objects/<displayId>.glb for the activity scenes.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { parseM2 } from '../m2/m2.js';
import { decodeBLP } from '../blp/blp.js';
import { m2ToGLB } from '../gltf/m2-to-glb.js';

export function convertObject(client: Client, displayId: number, cacheDir: string): boolean {
  const gdi = client.dbc('GameObjectDisplayInfo'); // 0 id, 1 model
  const r = gdi.rows().find(i => gdi.u32(i, 0) === displayId);
  const model = r === undefined ? '' : gdi.str(r, 1);
  if (!/\.(mdx|mdl|m2)$/i.test(model)) return false; // buildings (WMO) aren't used in scenes
  const file = model.replace(/\.(mdx|mdl)$/i, '.m2');
  const m = parseM2(client.read(file));
  const glb = m2ToGLB(m, {
    name: path.win32.basename(file, '.m2'),
    animationNames: client.animationNames(),
    keepAnimation: n => n === 'Stand',
    resolveTexture: slot => {
      const t = m.textures[slot];
      const buf = t?.type === 0 && t.filename ? client.archives.read(t.filename) : null;
      return buf ? { image: decodeBLP(buf), name: path.win32.basename(t!.filename) } : null;
    },
  });
  const out = path.join(cacheDir, 'objects');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${displayId}.glb`), glb);
  return true;
}
