// Assembles player and humanoid NPC models at runtime from the race model + CharSections pieces.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface Look { race: number; sex: number; skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number }
export interface HumanoidSpec extends Look { bake: string | null; geosets: Record<number, number> }

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

  // ---- geosets
  const want = (id: number): boolean => {
    if (id === 0) return true;
    const group = Math.floor(id / 100);
    if (group === 0) return id === (hairGeo?.geoset || 1);
    if (group === 1) return id === 100 + (facial?.g1 ?? 1);
    if (group === 2) return id === 200 + (facial?.g2 ?? 1);
    if (group === 3) return id === 300 + (facial?.g3 ?? 1);
    return id === (spec.geosets[group] ?? DEFAULT_GEOSETS[group]);
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
  const skinTex = new THREE.CanvasTexture(canvas);
  skinTex.flipY = false; // glTF UV convention
  skinTex.colorSpace = THREE.SRGBColorSpace;
  const hairImg = hairSec?.tex[0] ? await loadImage(hairSec.tex[0]) : null;
  let hairTex: THREE.Texture = skinTex;
  if (hairImg) { hairTex = new THREE.Texture(hairImg); hairTex.flipY = false; hairTex.colorSpace = THREE.SRGBColorSpace; hairTex.needsUpdate = true; }

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
      c.needsUpdate = true;
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(paint) : paint(m.material);
  });

  const defs = (gltf.parser.json.animations ?? []) as { extras?: { durationS?: number } }[];
  return { root, animations: gltf.animations, durations: defs.map(d => d.extras?.durationS) };
}
