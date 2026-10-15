// Converts a creature display (CreatureDisplayInfo id) into cache/creatures/<id>.glb.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { parseM2 } from '../m2/m2.js';
import { decodeBLP } from '../blp/blp.js';
import { m2ToGLB } from '../gltf/m2-to-glb.js';

// M2 texture types 11-13 are the creature's skin variations from CreatureDisplayInfo.
const MONSTER_SKIN_1 = 11;

export interface CreatureManifestEntry {
  displayId: number; model: string; scale: number; file: string;
  skins: string[]; animations: number; bytes: number;
}

export function convertCreature(client: Client, displayId: number, cacheDir: string): CreatureManifestEntry {
  const display = client.creatureDisplays().get(displayId);
  if (!display) throw new Error(`no CreatureDisplayInfo ${displayId}`);
  if (display.extraId) throw new Error(`display ${displayId} is a humanoid (CreatureDisplayInfoExtra), not supported yet`);
  const model = parseM2(client.read(display.modelPath));
  const dir = path.win32.dirname(display.modelPath);

  const glb = m2ToGLB(model, {
    name: path.win32.basename(display.modelPath, '.m2'),
    animationNames: client.animationNames(),
    resolveTexture: slot => {
      const t = model.textures[slot];
      if (!t) return null;
      let file: string | null = null;
      if (t.type === 0 && t.filename) file = t.filename;
      else if (t.type >= MONSTER_SKIN_1 && t.type <= MONSTER_SKIN_1 + 2) {
        const skin = display.skins[t.type - MONSTER_SKIN_1];
        if (skin) file = `${dir}\\${skin}.blp`;
      }
      if (!file) return null;
      const buf = client.archives.read(file);
      return buf ? { image: decodeBLP(buf), name: path.win32.basename(file) } : null;
    },
  });

  const outDir = path.join(cacheDir, 'creatures');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${displayId}.glb`);
  fs.writeFileSync(file, glb);
  const entry: CreatureManifestEntry = {
    displayId, model: display.modelPath, scale: display.scale, file: `creatures/${displayId}.glb`,
    skins: display.skins.filter(Boolean), animations: model.sequences.length, bytes: glb.length,
  };
  const manifestPath = path.join(outDir, 'index.json');
  const manifest: Record<string, CreatureManifestEntry> = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  manifest[displayId] = entry;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return entry;
}
