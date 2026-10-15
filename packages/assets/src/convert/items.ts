// Equipped-item art (ItemDisplayInfo), converted on demand like creatures:
//   items/<displayId>.json  geosets, the body-texture pieces per region, and which models exist
//   items/<displayId>-<side>[-<raceSex>].glb  attached models: helmets (per race/sex), shoulders,
//                                           weapons and shields
// The client composites the texture pieces onto the character's body texture and parents the
// models to the character's attachment points.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { parseM2 } from '../m2/m2.js';
import { decodeBLP } from '../blp/blp.js';
import { m2ToGLB } from '../gltf/m2-to-glb.js';
import { writeTexture } from './characters.js';

/** Body texture regions, in ItemDisplayInfo column order (14-21) and their texture-component folders. */
export const ITEM_REGIONS = ['armUpper', 'armLower', 'hand', 'torsoUpper', 'torsoLower', 'legUpper', 'legLower', 'foot'] as const;
const REGION_DIRS = ['ArmUpperTexture', 'ArmLowerTexture', 'HandTexture', 'TorsoUpperTexture', 'TorsoLowerTexture', 'LegUpperTexture', 'LegLowerTexture', 'FootTexture'];
/** Helmet model suffix per race (… _HuM.m2 for a human male). */
const RACE_CODES: Record<number, string> = { 1: 'Hu', 2: 'Or', 3: 'Dw', 4: 'Ni', 5: 'Sc', 6: 'Ta', 7: 'Gn', 8: 'Tr' };
const MODEL_DIRS = ['Head', 'Shoulder', 'Weapon', 'Shield', 'Quiver', 'Ammo'];

export interface ItemArt {
  displayId: number;
  /** ItemDisplayInfo geoset groups (gloves/sleeves, boots/trousers, robe/belt…) for the slot's rules. */
  geosets: [number, number, number];
  /** HelmetGeosetVisData ids for male/female (which hair/ears a helmet hides). */
  helmHide: [number, number];
  /** Texture piece per region, by sex: `u` (unisex) or `m`/`f`. Paths relative to the cache. */
  textures: Partial<Record<typeof ITEM_REGIONS[number], { m?: string; f?: string; u?: string }>>;
  /** Model folders for the left/right model, if the item has 3D models. */
  left?: string; right?: string;
  /** Cloaks: the cape texture the character model's cape geoset wears. */
  cape?: string;
}

function readDisplay(client: Client, displayId: number) {
  const idi = client.dbc('ItemDisplayInfo'); // 1-2 models, 3-4 model textures, 6-8 geosets, 12-13 helmet vis, 14-21 regions
  const r = idi.rows().find(i => idi.u32(i, 0) === displayId);
  if (r === undefined) return null;
  return {
    models: [idi.str(r, 1), idi.str(r, 2)], textures: [idi.str(r, 3), idi.str(r, 4)],
    geosets: [idi.u32(r, 6), idi.u32(r, 7), idi.u32(r, 8)] as [number, number, number],
    helmHide: [idi.u32(r, 12), idi.u32(r, 13)] as [number, number],
    regions: ITEM_REGIONS.map((_, i) => idi.str(r, 14 + i)),
  };
}

/** The archive path of an item model, trying each object-component folder (helmets per race/sex). */
function modelPath(client: Client, name: string, raceSex?: string): { file: string; dir: string } | null {
  const base = name.replace(/\.(mdx|mdl|m2)$/i, '');
  for (const d of MODEL_DIRS) {
    const dir = `Item\\ObjectComponents\\${d}`;
    const file = d === 'Head' ? (raceSex ? `${dir}\\${base}_${raceSex}.m2` : null) : `${dir}\\${base}.m2`;
    if (file && client.archives.read(file)) return { file, dir };
  }
  return null;
}

export function convertItemArt(client: Client, displayId: number, cacheDir: string): ItemArt {
  const d = readDisplay(client, displayId);
  if (!d) throw new Error(`no ItemDisplayInfo ${displayId}`);
  const art: ItemArt = { displayId, geosets: d.geosets, helmHide: d.helmHide, textures: {} };
  d.regions.forEach((name, i) => {
    if (!name) return;
    const dir = `Item\\TextureComponents\\${REGION_DIRS[i]}`;
    const t: { m?: string; f?: string; u?: string } = {};
    for (const [k, suffix] of [['u', 'U'], ['m', 'M'], ['f', 'F']] as const) {
      const rel = writeTexture(client, cacheDir, `${dir}\\${name}_${suffix}.blp`);
      if (rel) t[k] = rel;
    }
    if (t.u || t.m || t.f) art.textures[ITEM_REGIONS[i]] = t;
  });
  const folder = (name: string) => {
    if (!name) return undefined;
    const p = modelPath(client, name, 'HuM') ?? modelPath(client, name);
    return p ? path.win32.basename(p.dir) : undefined;
  };
  art.left = folder(d.models[0]);
  art.right = folder(d.models[1]);
  if (!d.models[0] && d.textures[0]) {
    const cape = writeTexture(client, cacheDir, `Item\\ObjectComponents\\Cape\\${d.textures[0]}.blp`);
    if (cape) art.cape = cape;
  }
  const out = path.join(cacheDir, 'items');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${displayId}.json`), JSON.stringify(art));
  return art;
}

/** items/<displayId>-<left|right>[-<raceCode><M|F>].glb */
export function convertItemModel(client: Client, displayId: number, side: 'left' | 'right', race: number | null, sex: 'M' | 'F' | null, cacheDir: string): boolean {
  const d = readDisplay(client, displayId);
  if (!d) return false;
  const i = side === 'left' ? 0 : 1;
  const raceSex = race && sex && RACE_CODES[race] ? `${RACE_CODES[race]}${sex}` : undefined;
  const p = d.models[i] ? modelPath(client, d.models[i], raceSex) : null;
  if (!p) return false;
  const model = parseM2(client.read(p.file));
  const skin = d.textures[i] || d.textures[0];
  const glb = m2ToGLB(model, {
    name: path.win32.basename(p.file, '.m2'),
    animationNames: client.animationNames(),
    keepAnimation: () => false, // item models are static (glows and spinning parts aside)
    resolveTexture: slot => {
      const t = model.textures[slot];
      if (!t) return null;
      const file = t.type === 0 && t.filename ? t.filename : t.type === 2 && skin ? `${p.dir}\\${skin}.blp` : null;
      const buf = file ? client.archives.read(file) : null;
      return buf ? { image: decodeBLP(buf), name: path.win32.basename(file!) } : null;
    },
  });
  const out = path.join(cacheDir, 'items');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${displayId}-${side}${raceSex ? `-${raceSex}` : ''}.glb`), glb);
  return true;
}
