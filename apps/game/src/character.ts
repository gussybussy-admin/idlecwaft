// Assembles player and humanoid NPC models at runtime from the race model + CharSections pieces.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface Look { race: number; sex: number; skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number }
/** An equipped item to show: its ItemDisplayInfo id and inventory type (which decides where it goes). */
export interface GearPiece { displayId: number; invType: number; slot: string; glow?: { color: number; size: number } }
export interface HumanoidSpec extends Look { bake: string | null; geosets: Record<number, number>; gear?: GearPiece[] }

/** items/<display>.json from the converter (packages/assets/src/convert/items.ts). */
interface ItemArt {
  geosets: [number, number, number]; helmHide: [number, number];
  textures: Partial<Record<keyof typeof GEAR_REGION, { m?: string; f?: string; u?: string }>>;
  left?: string; right?: string; cape?: string;
}
// Where armor texture pieces go on the 256x256 body texture.
const GEAR_REGION = {
  armUpper: [0, 0, 128, 64], armLower: [0, 64, 128, 64], hand: [0, 128, 128, 32],
  torsoUpper: [128, 0, 128, 64], torsoLower: [128, 64, 128, 32], legUpper: [128, 96, 128, 64],
  legLower: [128, 160, 128, 64], foot: [128, 224, 128, 32],
} as const;
// Inventory types, in the order their textures are layered (later covers earlier), as the game does.
const LAYER_ORDER = [4, 7, 8, 5, 20, 9, 10, 6, 19];
const RACE_CODES: Record<number, string> = { 1: 'Hu', 2: 'Or', 3: 'Dw', 4: 'Ni', 5: 'Sc', 6: 'Ta', 7: 'Gn', 8: 'Tr' };
const itemArtCache = new Map<number, Promise<ItemArt | null>>();
const itemArt = (id: number) => {
  if (!itemArtCache.has(id)) itemArtCache.set(id, fetch(`items/${id}.json`).then(r => (r.ok ? r.json() as Promise<ItemArt> : null)).catch(() => null));
  return itemArtCache.get(id)!;
};

interface CharSection { race: number; sex: number; type: number; variation: number; color: number; tex: string[] }
interface CharacterIndex {
  models: Record<string, string>;
  sections: CharSection[];
  hair: { race: number; sex: number; variation: number; geoset: number; showScalp: boolean }[];
  facial: { race: number; sex: number; variation: number; g1: number; g2: number; g3: number }[];
}

const SKIN = 0, FACE = 1, FACIAL_HAIR = 2, HAIR = 3, UNDERWEAR = 4;
// Vanilla 256x256 character texture layout (x, y, w, h).
const REGION = {
  faceUpper: [0, 160, 128, 32], faceLower: [0, 192, 128, 64],
  torsoUpper: [128, 0, 128, 64], legUpper: [128, 96, 128, 64],
} as const;
/** Default geoset per group when nothing overrides it: bare hands/feet, ears, trousers, no cape. */
const DEFAULT_GEOSETS: Record<number, number> = { 4: 401, 5: 501, 7: 702, 13: 1301, 15: 1501 };

let indexPromise: Promise<CharacterIndex> | null = null;
export const characterIndex = (): Promise<CharacterIndex> =>
  (indexPromise ??= fetch('character/index.json').then(r => r.json() as Promise<CharacterIndex>));

const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF>>();
const loadGLTF = (url: string) => { if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url)); return gltfCache.get(url)!; };
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  if (!imgCache.has(url)) imgCache.set(url, new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; }));
  return imgCache.get(url)!;
}

/** Valid appearance options for a race/sex, for character creation and the barber. */
export async function lookOptions(race: number, sex: number) {
  const idx = await characterIndex();
  const secs = idx.sections.filter(s => s.race === race && s.sex === sex);
  const uniq = (type: number, key: 'variation' | 'color') => [...new Set(secs.filter(s => s.type === type).map(s => s[key]))].sort((a, b) => a - b);
  return {
    skins: uniq(SKIN, 'color'), faces: uniq(FACE, 'variation'), hairStyles: uniq(HAIR, 'variation'),
    hairColors: uniq(HAIR, 'color'), facialHair: uniq(FACIAL_HAIR, 'variation'),
  };
}

export async function randomLook(race: number, sex: number, rand = Math.random): Promise<Look> {
  const o = await lookOptions(race, sex);
  const pick = (a: number[]) => a.length ? a[Math.floor(rand() * a.length)] : 0;
  return { race, sex, skin: pick(o.skins), face: pick(o.faces), hairStyle: pick(o.hairStyles), hairColor: pick(o.hairColors), facialHair: sex === 0 ? pick(o.facialHair) : 0 };
}

export interface BuiltCharacter { root: THREE.Object3D; animations: THREE.AnimationClip[]; durations: (number | undefined)[] }

export async function buildCharacter(spec: HumanoidSpec): Promise<BuiltCharacter | null> {
  const idx = await characterIndex();
  const url = idx.models[`${spec.race}:${spec.sex}`];
  if (!url) return null;
  const gltf = await loadGLTF(url);
  const root = cloneSkinned(gltf.scene);

  const sec = (type: number, variation: number, color: number) =>
    idx.sections.find(s => s.race === spec.race && s.sex === spec.sex && s.type === type && s.variation === variation && s.color === color);
  const hairGeo = idx.hair.find(h => h.race === spec.race && h.sex === spec.sex && h.variation === spec.hairStyle);
  const facial = idx.facial.find(f => f.race === spec.race && f.sex === spec.sex && f.variation === spec.facialHair);

  // ---- equipped gear: geosets from each piece's rules (sleeves, gloves, boots, robe, cape)
  const gear = await Promise.all((spec.gear ?? []).map(async g => ({ ...g, art: await itemArt(g.displayId) })));
  const geosets = { ...spec.geosets };
  let helmed = false, cape: string | undefined;
  for (const { invType, art } of gear) {
    if (!art) continue;
    const [g1, , g3] = art.geosets;
    if (invType === 10) geosets[4] = 401 + g1;                           // gloves
    else if (invType === 8) geosets[5] = 501 + g1;                       // boots
    else if (invType === 4 || invType === 5 || invType === 20) {         // shirt, chest, robe: sleeves
      geosets[8] = 801 + g1;
      if (g3) geosets[13] = 1301 + g3;                                   // robe skirt
    } else if (invType === 7) { geosets[9] = 901 + g1; if (g3) geosets[13] = 1301 + g3; }
    else if (invType === 19) geosets[12] = 1202;                         // tabard
    else if (invType === 6 && g1) geosets[18] = 1801 + g1;                // belt buckle
    else if (invType === 16 && art.cape) { geosets[15] = 1502 + g1; cape = art.cape; }
    else if (invType === 1 && art.helmHide[spec.sex]) helmed = true;
  }

  // ---- geosets
  const want = (id: number): boolean => {
    if (id === 0) return true;
    const group = Math.floor(id / 100);
    if (group === 0) return !helmed && id === (hairGeo?.geoset || 1); // most helmets hide the hair
    if (group === 1) return id === 100 + (facial?.g1 ?? 1);
    if (group === 2) return id === 200 + (facial?.g2 ?? 1);
    if (group === 3) return id === 300 + (facial?.g3 ?? 1);
    return id === (geosets[group] ?? DEFAULT_GEOSETS[group]);
  };
  root.traverse(o => {
    const ids = (o.userData as { submeshIds?: number[] }).submeshIds;
    if (!ids) return;
    const meshes = (o as THREE.Mesh).isMesh ? [o] : o.children;
    meshes.forEach((m, i) => { if (ids[i] !== undefined) m.visible = want(ids[i]); });
  });

  // ---- body texture: NPC bake, or composite skin + face + facial hair + scalp + underwear
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const draw = async (tex: string | undefined, r?: readonly number[]) => {
    if (!tex) return;
    const img = await loadImage(tex);
    if (!img) return;
    if (r) ctx.drawImage(img, r[0], r[1], r[2], r[3]); else ctx.drawImage(img, 0, 0, 256, 256);
  };
  const hairSec = sec(HAIR, spec.hairStyle, spec.hairColor);
  if (spec.bake) {
    await draw(spec.bake);
  } else {
    const base = sec(SKIN, 0, spec.skin);
    await draw(base?.tex[0]);
    const face = sec(FACE, spec.face, spec.skin);
    await draw(face?.tex[0], REGION.faceLower); await draw(face?.tex[1], REGION.faceUpper);
    const fh = sec(FACIAL_HAIR, spec.facialHair, spec.hairColor);
    await draw(fh?.tex[0], REGION.faceLower); await draw(fh?.tex[1], REGION.faceUpper);
    if (hairGeo?.showScalp !== false) { await draw(hairSec?.tex[1], REGION.faceLower); await draw(hairSec?.tex[2], REGION.faceUpper); }
    // Not every skin colour has its own underwear texture; fall back to the race's first one.
    const under = sec(UNDERWEAR, 0, spec.skin)
      ?? idx.sections.find(s => s.race === spec.race && s.sex === spec.sex && s.type === UNDERWEAR);
    await draw(under?.tex[0], REGION.legUpper); await draw(under?.tex[1], REGION.torsoUpper);
  }
  // Armor texture pieces, layered shirt → legs → boots → chest → wrists → gloves → belt → tabard.
  const sexKey = spec.sex === 0 ? 'm' : 'f';
  for (const inv of LAYER_ORDER) {
    for (const { art } of gear.filter(g => g.invType === inv)) {
      for (const [region, t] of Object.entries(art?.textures ?? {})) {
        const file = t?.[sexKey] ?? t?.u;
        if (file) await draw(file, GEAR_REGION[region as keyof typeof GEAR_REGION]);
      }
    }
  }
  const skinTex = new THREE.CanvasTexture(canvas);
  skinTex.flipY = false; // glTF UV convention
  skinTex.colorSpace = THREE.SRGBColorSpace;
  const hairImg = hairSec?.tex[0] ? await loadImage(hairSec.tex[0]) : null;
  let hairTex: THREE.Texture = skinTex;
  if (hairImg) { hairTex = new THREE.Texture(hairImg); hairTex.flipY = false; hairTex.colorSpace = THREE.SRGBColorSpace; hairTex.needsUpdate = true; }
  const capeImg = cape ? await loadImage(cape) : null;
  let capeTex: THREE.Texture | null = null;
  if (capeImg) { capeTex = new THREE.Texture(capeImg); capeTex.flipY = false; capeTex.colorSpace = THREE.SRGBColorSpace; capeTex.needsUpdate = true; }

  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.frustumCulled = false;
    const paint = (mat: THREE.Material) => {
      const type = (mat.userData as { wowTextureType?: number }).wowTextureType ?? 0;
      const c = (mat as THREE.MeshStandardMaterial).clone(); // per-character: materials are shared by the glTF
      if (type === 1 || type === 8) c.map = skinTex;
      else if (type === 6) { c.map = hairTex; c.alphaTest = 0.5; c.transparent = false; }
      else if (type === 2 && capeTex) { c.map = capeTex; c.side = THREE.DoubleSide; }
      c.needsUpdate = true;
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(paint) : paint(m.material);
  });

  // ---- attached models: helmet, shoulders, weapons, shield (character attachment points)
  const raceSex = `${RACE_CODES[spec.race] ?? 'Hu'}${spec.sex === 0 ? 'M' : 'F'}`;
  const attach = async (url: string, point: number, glow?: GearPiece['glow']) => {
    const node = root.getObjectByName(`attach${point}`);
    const g = node ? await loadGLTF(url).catch(() => null) : null;
    if (!node || !g) return;
    const model = cloneSkinned(g.scene);
    if (glow) addGlow(model, glow);
    // The item's own root turns WoW Z-up into Y-up; the attachment point is already in WoW space.
    model.getObjectByName('root')?.quaternion.identity();
    model.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
    node.add(model);
  };
  await Promise.all(gear.flatMap(({ displayId, invType, slot, art, glow }) => {
    if (!art) return [];
    const url = (side: 'left' | 'right', perRace = false) => `items/${displayId}-${side}${perRace ? `-${raceSex}` : ''}.glb`;
    if (invType === 1 && art.left) return [attach(url('left', true), 11)];
    if (invType === 3) return [art.left && attach(url('left'), 6), art.right && attach(url('right'), 5)].filter(Boolean) as Promise<void>[];
    if (invType === 14 && art.left) return [attach(url('left'), 0)];                    // shield
    if (art.left && slot === 'mainhand') return [attach(url('left'), 1, glow)];          // right hand
    if (art.left && slot === 'offhand') return [attach(url('left'), 2, glow)];           // left hand
    return [];
  }));

  const defs = (gltf.parser.json.animations ?? []) as { extras?: { durationS?: number } }[];
  return { root, animations: gltf.animations, durations: defs.map(d => d.extras?.durationS) };
}

// ---- enchantment glow: a soft additive halo along the weapon and a small light in its colour
let glowTexture: THREE.Texture | null = null;
function glowSprite(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}
function addGlow(model: THREE.Object3D, glow: { color: number; size: number }): void {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const long = Math.max(size.x, size.y, size.z) || 1;
  const axis = size.x === long ? 'x' : size.y === long ? 'y' : 'z';
  const mat = new THREE.SpriteMaterial({ map: glowSprite(), color: glow.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    opacity: 0.35 + glow.size * 0.15 });
  // A few halos spaced along the blade, the biggest in the middle.
  const n = 4;
  for (let i = 0; i < n; i++) {
    const sp = new THREE.Sprite(mat);
    const p = center.clone();
    p[axis] = box.min[axis] + (long * (i + 0.5)) / n;
    sp.position.copy(model.worldToLocal(p.clone()));
    const k = (0.18 + glow.size * 0.06) * long * (1 - Math.abs(i - (n - 1) / 2) / n);
    sp.scale.set(k, k, k);
    model.add(sp);
  }
  const light = new THREE.PointLight(glow.color, 0.6 + glow.size * 0.3, 2.5);
  light.position.copy(model.worldToLocal(center.clone()));
  model.add(light);
}
