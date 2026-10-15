// Converts a parsed v256 M2 into a skinned, animated glTF binary.
//
// Bones: WoW animates each bone as  Parent * T(pivot) * T(t) * R * S * T(-pivot).
// Placing every glTF joint at its pivot gives the local transform  T(pivot - parentPivot + t) * R * S,
// with inverse bind matrix T(-pivot). A root node rotates WoW's Z-up space into glTF's Y-up.
import type { M2Model, M2Track, Vec3, Quat } from '../m2/m2.js';
import { trackKeys } from '../m2/m2.js';
import type { RGBAImage } from '../blp/blp.js';
import { encodePNG } from '../img/png.js';
import { GLTFBuilder } from './glb.js';

export interface ConvertOptions {
  /** Resolves an M2 texture slot to pixels; null leaves the slot untextured. */
  resolveTexture(slot: number): { image: RGBAImage; name: string } | null;
  /** AnimationData.dbc id -> name, e.g. 0 -> "Stand". */
  animationNames: Map<number, string>;
  skinProfile?: number;
  name?: string;
  /** Which animations to export, by AnimationData name (default: all). */
  keepAnimation?: (name: string) => boolean;
}

const SEQ_ALIAS = 0x40;
const REPEAT = 10497, CLAMP = 33071;

export function m2ToGLB(m: M2Model, opts: ConvertOptions): Buffer {
  const g = new GLTFBuilder();
  const skin = m.skins[opts.skinProfile ?? 0];
  if (!skin) throw new Error('model has no skin profile');

  // ---- vertex attributes (all global vertices; primitives index into them)
  const n = m.vertices.length;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const joints = new Uint8Array(n * 4), weights = new Uint8Array(n * 4);
  m.vertices.forEach((v, i) => {
    pos.set(v.pos, i * 3);
    const len = Math.hypot(...v.normal) || 1;
    nrm.set(v.normal.map(c => c / len), i * 3);
    uv.set(v.uv, i * 2);
    joints.set(v.bones, i * 4);
    // Weights must sum to 255 for normalized u8; fix rounding drift onto the largest weight.
    const w = [...v.weights];
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum === 0) { w[0] = 255; } else if (sum !== 255) {
      const k = w.indexOf(Math.max(...w)); w[k] += 255 - sum;
    }
    weights.set(w, i * 4);
  });
  const attributes = {
    POSITION: g.accessor(pos, 'VEC3', { minmax: true, vertex: true }),
    NORMAL: g.accessor(nrm, 'VEC3', { vertex: true }),
    TEXCOORD_0: g.accessor(uv, 'VEC2', { vertex: true }),
    JOINTS_0: g.accessor(joints, 'VEC4', { vertex: true }),
    WEIGHTS_0: g.accessor(weights, 'VEC4', { normalized: true, vertex: true }),
  };

  // ---- textures and materials (one glTF material per M2 material x texture pair)
  const samplers = new Map<number, number>();
  const sampler = (flags: number) => {
    if (!samplers.has(flags)) samplers.set(flags, g.push('samplers', {
      magFilter: 9729, minFilter: 9987, wrapS: flags & 1 ? REPEAT : CLAMP, wrapT: flags & 2 ? REPEAT : CLAMP,
    }));
    return samplers.get(flags)!;
  };
  const textureIndex = new Map<number, number | null>();
  const gltfTexture = (slot: number) => {
    if (!textureIndex.has(slot)) {
      const res = opts.resolveTexture(slot);
      textureIndex.set(slot, res ? g.push('textures', {
        source: g.image(encodePNG(res.image), res.name), sampler: sampler(m.textures[slot]?.flags ?? 0),
      }) : null);
    }
    return textureIndex.get(slot)!;
  };
  const materialIndex = new Map<string, number>();
  const gltfMaterial = (matIdx: number, texSlot: number) => {
    const key = `${matIdx}:${texSlot}`;
    if (!materialIndex.has(key)) {
      const mat = m.materials[matIdx] ?? { flags: 0, blendMode: 0 };
      const tex = gltfTexture(texSlot);
      const item: Record<string, unknown> = {
        name: `mat${matIdx}_tex${texSlot}`,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
          ...(tex !== null ? { baseColorTexture: { index: tex } } : {}) },
        doubleSided: !!(mat.flags & 0x4),
        // wowTextureType tells the client which runtime texture (1 skin, 2 cape, 6 hair, 11-13 creature skins) belongs here.
        extras: { wowBlendMode: mat.blendMode, wowRenderFlags: mat.flags, wowTextureType: m.textures[texSlot]?.type ?? 0 },
      };
      if (mat.blendMode === 1) { item.alphaMode = 'MASK'; item.alphaCutoff = 0.5; }
      else if (mat.blendMode >= 2) item.alphaMode = 'BLEND';
      if (mat.flags & 0x1) { item.extensions = { KHR_materials_unlit: {} }; g.useExtension('KHR_materials_unlit'); }
      materialIndex.set(key, g.push('materials', item));
    }
    return materialIndex.get(key)!;
  };

  // ---- primitives: one per batch, skipping environment-mapped overlay layers (not supported yet)
  const primitives: Record<string, unknown>[] = [];
  const order = [...skin.batches].sort((a, b) => a.priorityPlane - b.priorityPlane || a.materialLayer - b.materialLayer);
  for (const b of order) {
    if (m.texCoordLookup[b.texCoordComboIndex] === 0xffff) continue;
    const sm = skin.submeshes[b.submeshIndex];
    if (!sm) continue;
    const idx = new Uint16Array(sm.indexCount);
    for (let i = 0; i < sm.indexCount; i++) idx[i] = skin.vertices[skin.indices[sm.indexStart + i]];
    primitives.push({
      attributes, indices: g.accessor(idx, 'SCALAR', { index: true }),
      material: gltfMaterial(b.materialIndex, m.textureLookup[b.textureComboIndex]),
      extras: { submeshId: sm.id },
    });
  }

  // ---- skeleton
  const rootNode = g.push('nodes', { name: 'root', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [] });
  const boneNode = m.bones.map((b, i) => {
    const parentPivot: Vec3 = b.parent >= 0 ? m.bones[b.parent].pivot : [0, 0, 0];
    return g.push('nodes', {
      name: `bone${i}${b.keyBoneId >= 0 ? `_key${b.keyBoneId}` : ''}`,
      translation: sub(b.pivot, parentPivot),
    });
  });
  m.bones.forEach((b, i) => {
    const parent = b.parent >= 0 ? g.json.nodes[boneNode[b.parent]] : g.json.nodes[rootNode];
    ((parent.children ??= []) as number[]).push(boneNode[i]);
  });
  // Attachment points (helmet, shoulders, hands, ...) as child nodes `attach<id>` of their bone, so
  // item models can be parented to them and follow the animation.
  for (const a of m.attachments) {
    const bone = m.bones[a.bone];
    if (!bone) continue;
    const node = g.push('nodes', { name: `attach${a.id}`, translation: sub(a.pos, bone.pivot) });
    ((g.json.nodes[boneNode[a.bone]].children ??= []) as number[]).push(node);
  }
  const ibm = new Float32Array(m.bones.length * 16);
  m.bones.forEach((b, i) => {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.pivot[0], -b.pivot[1], -b.pivot[2], 1], i * 16);
  });
  const skinIdx = g.push('skins', { joints: boneNode, skeleton: rootNode, inverseBindMatrices: g.accessor(ibm, 'MAT4') });
  // Geoset (submesh) id per primitive, in primitive order, so the client can toggle hair, gloves, robes...
  // Stored on the node: three's GLTFLoader copies node extras to userData, but not mesh extras.
  const mesh = g.push('meshes', { name: opts.name ?? m.name, primitives });
  const meshNode = g.push('nodes', { name: opts.name ?? m.name, mesh, skin: skinIdx,
    extras: { submeshIds: primitives.map(p => (p.extras as { submeshId: number }).submeshId) } });

  // ---- animations: one clip per sequence.
  // Channels are only written for properties some sequence actually animates; everything else stays
  // at its rest value on the node. Animated properties get a constant key in clips that don't move
  // them, so switching clips never leaves a bone posed by the previous animation.
  const animated = (t: M2Track<unknown>) => t.globalSequence < 0 && t.timestamps.length > 0;
  const moves = m.bones.map(b => ({ t: animated(b.translation), r: animated(b.rotation), s: animated(b.scale) }));
  const seenNames = new Map<string, number>();
  m.sequences.forEach((seq, si) => {
    if (seq.flags & SEQ_ALIAS) return;
    const base = opts.animationNames.get(seq.id) ?? `Anim${seq.id}`;
    if (opts.keepAnimation && !opts.keepAnimation(base)) return;
    const count = seenNames.get(base) ?? 0;
    seenNames.set(base, count + 1);
    const name = count ? `${base}_${count}` : base;
    const samplersOut: Record<string, unknown>[] = [], channels: Record<string, unknown>[] = [];
    const durationS = Math.max(seq.end - seq.start, 1) / 1000;
    const channel = (node: number, path: string, times: number[], values: number[], comps: number, step: boolean) => {
      samplersOut.push({
        input: g.accessor(new Float32Array(times), 'SCALAR', { minmax: true }),
        output: g.accessor(new Float32Array(values), comps === 4 ? 'VEC4' : 'VEC3'),
        interpolation: step ? 'STEP' : 'LINEAR',
      });
      channels.push({ sampler: samplersOut.length - 1, target: { node, path } });
    };
    m.bones.forEach((b, bi) => {
      const parentPivot: Vec3 = b.parent >= 0 ? m.bones[b.parent].pivot : [0, 0, 0];
      const rest = sub(b.pivot, parentPivot);
      if (moves[bi].t) {
        const t = keysOrConstant(b.translation, si, seq, [0, 0, 0] as Vec3);
        channel(boneNode[bi], 'translation', t.times, t.values.flatMap(v => [v[0] + rest[0], v[1] + rest[1], v[2] + rest[2]]), 3, b.translation.interpolation === 0);
      }
      if (moves[bi].r) {
        const r = keysOrConstant(b.rotation, si, seq, [0, 0, 0, 1] as Quat);
        channel(boneNode[bi], 'rotation', r.times, r.values.flatMap(normalize), 4, b.rotation.interpolation === 0);
      }
      if (moves[bi].s) {
        const s = keysOrConstant(b.scale, si, seq, [1, 1, 1] as Vec3);
        channel(boneNode[bi], 'scale', s.times, s.values.flat(), 3, b.scale.interpolation === 0);
      }
    });
    if (!channels.length) return;
    g.push('animations', {
      name, samplers: samplersOut, channels,
      extras: { sequenceId: seq.id, variation: seq.variation, durationMs: seq.end - seq.start,
        durationS, moveSpeed: seq.moveSpeed, flags: seq.flags, frequency: seq.frequency },
    });
  });

  g.json.scenes.push({ nodes: [rootNode, meshNode] });
  g.json.extras = {
    source: 'm2', version: m.version, boundingRadius: m.boundingRadius,
    textureSlots: m.textures.map(t => ({ type: t.type, flags: t.flags, filename: t.filename })),
  };
  return g.toGLB();
}

function keysOrConstant<T>(track: M2Track<T>, si: number, seq: Parameters<typeof trackKeys>[2], fallback: T) {
  if (track.globalSequence >= 0) return { times: [0], values: [track.values[0] ?? fallback] };
  const k = trackKeys(track, si, seq);
  return k.times.length ? { times: k.times.map(t => t / 1000), values: k.values } : { times: [0], values: [fallback] };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (q: Quat): number[] => { const l = Math.hypot(...q) || 1; return q.map(c => c / l); };
