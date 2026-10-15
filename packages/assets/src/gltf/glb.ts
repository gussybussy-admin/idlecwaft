// Tiny glTF 2.0 builder that writes a single binary .glb (JSON chunk + BIN chunk).
export const FLOAT = 5126, UNSIGNED_BYTE = 5121, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

type Json = Record<string, unknown>;

export class GLTFBuilder {
  readonly json: Json & {
    asset: Json; scenes: Json[]; nodes: Json[]; meshes: Json[]; skins: Json[]; animations: Json[];
    accessors: Json[]; bufferViews: Json[]; buffers: Json[]; materials: Json[]; textures: Json[];
    images: Json[]; samplers: Json[]; extensionsUsed: string[];
  } = {
    asset: { version: '2.0', generator: 'idlecwaft asset pipeline' },
    scene: 0, scenes: [], nodes: [], meshes: [], skins: [], animations: [],
    accessors: [], bufferViews: [], buffers: [], materials: [], textures: [], images: [], samplers: [],
    extensionsUsed: [],
  };
  private chunks: Buffer[] = [];
  private length = 0;

  private view(data: Buffer, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.length += pad; }
    this.json.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: data.length, ...(target ? { target } : {}) });
    this.chunks.push(data); this.length += data.length;
    return this.json.bufferViews.length - 1;
  }

  accessor(data: Float32Array | Uint8Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4',
    opts: { normalized?: boolean; index?: boolean; minmax?: boolean; vertex?: boolean } = {}): number {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint8Array ? UNSIGNED_BYTE
      : data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT;
    const bufferView = this.view(Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      opts.index ? ELEMENT_ARRAY_BUFFER : opts.vertex ? ARRAY_BUFFER : undefined);
    const acc: Json = { bufferView, componentType, count: data.length / comps, type };
    if (opts.normalized) acc.normalized = true;
    if (opts.minmax) {
      const min = new Array(comps).fill(Infinity), max = new Array(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i++) { const c = i % comps; min[c] = Math.min(min[c], data[i]); max[c] = Math.max(max[c], data[i]); }
      acc.min = min; acc.max = max;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  image(png: Buffer, name: string): number {
    this.json.images.push({ bufferView: this.view(png), mimeType: 'image/png', name });
    return this.json.images.length - 1;
  }

  push<K extends 'nodes' | 'meshes' | 'skins' | 'animations' | 'materials' | 'textures' | 'samplers'>(key: K, item: Json): number {
    this.json[key].push(item);
    return this.json[key].length - 1;
  }

  useExtension(name: string): void {
    if (!this.json.extensionsUsed.includes(name)) this.json.extensionsUsed.push(name);
  }

  toGLB(): Buffer {
    const bin = Buffer.concat(this.chunks);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    this.json.buffers = [{ byteLength: binPadded.length }];
    const json: Json = { ...this.json };
    for (const k of Object.keys(json)) if (Array.isArray(json[k]) && (json[k] as unknown[]).length === 0) delete json[k];
    let text = Buffer.from(JSON.stringify(json), 'utf8');
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + text.length + 8 + binPadded.length, 8);
    const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    return Buffer.concat([header, ch(text.length, 0x4e4f534a), text, ch(binPadded.length, 0x004e4942), binPadded]);
  }
}
