// M2 model parser for WoW 1.12 (version 256). Skin profiles are embedded in the M2 itself,
// animation tracks use one global timeline with per-sequence index ranges.

export interface M2Sequence {
  id: number; variation: number; start: number; end: number;
  moveSpeed: number; flags: number; frequency: number; blendTime: number;
  variationNext: number; aliasNext: number;
}

export interface M2Track<T> {
  interpolation: number;   // 0 none, 1 linear, 2 hermite, 3 bezier
  globalSequence: number;  // -1 = driven by the playing sequence
  ranges: [number, number][]; // per sequence: inclusive [first, last] index into timestamps
  timestamps: number[];
  values: T[];
}

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface M2Bone {
  keyBoneId: number; flags: number; parent: number; submeshId: number;
  translation: M2Track<Vec3>; rotation: M2Track<Quat>; scale: M2Track<Vec3>;
  pivot: Vec3;
}

export interface M2Vertex {
  pos: Vec3; weights: [number, number, number, number]; bones: [number, number, number, number];
  normal: Vec3; uv: [number, number];
}

export interface M2Submesh {
  id: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number;
  boneCount: number; boneComboIndex: number; centerBone: number;
}

export interface M2Batch {
  flags: number; priorityPlane: number; shaderId: number; submeshIndex: number;
  colorIndex: number; materialIndex: number; materialLayer: number; textureCount: number;
  textureComboIndex: number; texCoordComboIndex: number; transparencyComboIndex: number;
  textureTransformComboIndex: number;
}

export interface M2SkinProfile {
  vertices: number[];   // local -> global vertex index
  indices: number[];    // triangle list into `vertices`
  submeshes: M2Submesh[];
  batches: M2Batch[];
  boneCountMax: number;
}

export interface M2Texture { type: number; flags: number; filename: string }
export interface M2Material { flags: number; blendMode: number }

export interface M2Model {
  version: number;
  name: string;
  globalFlags: number;
  globalLoops: number[];
  sequences: M2Sequence[];
  bones: M2Bone[];
  vertices: M2Vertex[];
  skins: M2SkinProfile[];
  textures: M2Texture[];
  materials: M2Material[];
  textureLookup: number[];
  texCoordLookup: number[]; // 0xffff = sphere/environment mapped
  boneLookup: number[];
  boundingRadius: number;
}

export function parseM2(buf: Buffer): M2Model {
  if (buf.toString('latin1', 0, 4) !== 'MD20') throw new Error('not an M2 file');
  const version = buf.readUInt32LE(4);
  if (version < 256 || version > 257) throw new Error(`unsupported M2 version ${version} (expected 256)`);

  const arr = (o: number) => ({ count: buf.readUInt32LE(o), offset: buf.readUInt32LE(o + 4) });
  const list = <T>(o: number, stride: number, read: (p: number) => T): T[] => {
    const { count, offset } = arr(o);
    if (count && offset + count * stride > buf.length) throw new Error(`M2 array at 0x${o.toString(16)} out of bounds`);
    return Array.from({ length: count }, (_, i) => read(offset + i * stride));
  };
  const u16s = (o: number) => list(o, 2, p => buf.readUInt16LE(p));
  const vec3 = (p: number): Vec3 => [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)];

  const nameArr = arr(0x08);
  const name = buf.toString('latin1', nameArr.offset, nameArr.offset + Math.max(0, nameArr.count - 1));

  const sequences = list(0x1c, 68, p => ({
    id: buf.readUInt16LE(p), variation: buf.readUInt16LE(p + 2),
    start: buf.readUInt32LE(p + 4), end: buf.readUInt32LE(p + 8),
    moveSpeed: buf.readFloatLE(p + 12), flags: buf.readUInt32LE(p + 16),
    frequency: buf.readInt16LE(p + 20), blendTime: buf.readUInt32LE(p + 32),
    variationNext: buf.readInt16LE(p + 64), aliasNext: buf.readUInt16LE(p + 66),
  }));

  const track = <T>(p: number, stride: number, read: (q: number) => T): M2Track<T> => ({
    interpolation: buf.readUInt16LE(p),
    globalSequence: buf.readInt16LE(p + 2),
    ranges: list(p + 4, 8, q => [buf.readUInt32LE(q), buf.readUInt32LE(q + 4)] as [number, number]),
    timestamps: list(p + 12, 4, q => buf.readUInt32LE(q)),
    values: list(p + 20, stride, read),
  });

  const bones = list(0x34, 108, p => ({
    keyBoneId: buf.readInt32LE(p), flags: buf.readUInt32LE(p + 4),
    parent: buf.readInt16LE(p + 8), submeshId: buf.readUInt16LE(p + 10),
    translation: track(p + 12, 12, vec3),
    rotation: track(p + 40, 16, q => [buf.readFloatLE(q), buf.readFloatLE(q + 4), buf.readFloatLE(q + 8), buf.readFloatLE(q + 12)] as Quat),
    scale: track(p + 68, 12, vec3),
    pivot: vec3(p + 96),
  }));

  const vertices = list(0x44, 48, p => ({
    pos: vec3(p),
    weights: [buf[p + 12], buf[p + 13], buf[p + 14], buf[p + 15]] as [number, number, number, number],
    bones: [buf[p + 16], buf[p + 17], buf[p + 18], buf[p + 19]] as [number, number, number, number],
    normal: vec3(p + 20),
    uv: [buf.readFloatLE(p + 32), buf.readFloatLE(p + 36)] as [number, number],
  }));

  const skins = list(0x4c, 44, p => ({
    vertices: u16s(p),
    indices: u16s(p + 8),
    submeshes: list(p + 24, 32, q => ({
      id: buf.readUInt16LE(q),
      // `level` carries the high bits of vertexStart/indexStart for very large meshes.
      vertexStart: buf.readUInt16LE(q + 4) + (buf.readUInt16LE(q + 2) << 16),
      vertexCount: buf.readUInt16LE(q + 6),
      indexStart: buf.readUInt16LE(q + 8) + (buf.readUInt16LE(q + 2) << 16),
      indexCount: buf.readUInt16LE(q + 10),
      boneCount: buf.readUInt16LE(q + 12), boneComboIndex: buf.readUInt16LE(q + 14),
      centerBone: buf.readUInt16LE(q + 18),
    })),
    batches: list(p + 32, 24, q => ({
      flags: buf[q], priorityPlane: buf.readInt8(q + 1), shaderId: buf.readUInt16LE(q + 2),
      submeshIndex: buf.readUInt16LE(q + 4), colorIndex: buf.readInt16LE(q + 8),
      materialIndex: buf.readUInt16LE(q + 10), materialLayer: buf.readUInt16LE(q + 12),
      textureCount: buf.readUInt16LE(q + 14), textureComboIndex: buf.readUInt16LE(q + 16),
      texCoordComboIndex: buf.readUInt16LE(q + 18), transparencyComboIndex: buf.readUInt16LE(q + 20),
      textureTransformComboIndex: buf.readUInt16LE(q + 22),
    })),
    boneCountMax: buf.readUInt32LE(p + 40),
  }));

  const textures = list(0x5c, 16, p => {
    const f = arr(p + 8);
    return { type: buf.readUInt32LE(p), flags: buf.readUInt32LE(p + 4),
      filename: f.count ? buf.toString('latin1', f.offset, f.offset + f.count - 1) : '' };
  });

  return {
    version, name,
    globalFlags: buf.readUInt32LE(0x10),
    globalLoops: list(0x14, 4, p => buf.readUInt32LE(p)),
    sequences, bones, vertices, skins, textures,
    materials: list(0x84, 4, p => ({ flags: buf.readUInt16LE(p), blendMode: buf.readUInt16LE(p + 2) })),
    boneLookup: u16s(0x8c),
    textureLookup: u16s(0x94),
    texCoordLookup: u16s(0x9c),
    boundingRadius: buf.readFloatLE(0xcc),
  };
}

/** Keys of one track that belong to sequence `seq`, with times relative to the sequence start (ms). */
export function trackKeys<T>(t: M2Track<T>, seqIndex: number, seq: M2Sequence): { times: number[]; values: T[] } {
  if (t.globalSequence >= 0 || !t.timestamps.length) return { times: [], values: [] };
  let first: number, last: number;
  if (t.ranges.length > seqIndex) [first, last] = t.ranges[seqIndex];
  else { first = 0; last = t.timestamps.length - 1; }
  const times: number[] = [], values: T[] = [];
  for (let i = first; i <= last && i < t.timestamps.length; i++) {
    const ts = t.timestamps[i];
    if (ts < seq.start || ts > seq.end) continue;
    times.push(ts - seq.start); values.push(t.values[i]);
  }
  return { times, values };
}
