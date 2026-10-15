// Format tests on synthetic data: these run anywhere, no client needed.
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { decodeBLP } from '../src/blp/blp.js';
import { encodePNG } from '../src/img/png.js';
import { GLTFBuilder } from '../src/gltf/glb.js';
import { parseDBC } from '../src/dbc/dbc.js';

function blpHeader(compression: number, alphaDepth: number, alphaType: number, w: number, h: number, mip: Buffer, palette?: number[][]) {
  const head = Buffer.alloc(1172);
  head.write('BLP2', 0, 'latin1');
  head.writeUInt32LE(1, 4);
  head[8] = compression; head[9] = alphaDepth; head[10] = alphaType; head[11] = 0;
  head.writeUInt32LE(w, 12); head.writeUInt32LE(h, 16);
  head.writeUInt32LE(1172, 20); head.writeUInt32LE(mip.length, 84);
  palette?.forEach(([r, g, b, a], i) => { head[148 + i * 4] = b; head[149 + i * 4] = g; head[150 + i * 4] = r; head[151 + i * 4] = a; });
  return Buffer.concat([head, mip]);
}

describe('BLP', () => {
  it('decodes a DXT1 block: pure red and pure blue endpoints', () => {
    const block = Buffer.alloc(8);
    block.writeUInt16LE(0xf800, 0); // red
    block.writeUInt16LE(0x001f, 2); // blue
    block.writeUInt32LE(0b01_00_01_00, 4); // texels 0..3 alternate red/blue
    const img = decodeBLP(blpHeader(2, 0, 0, 4, 4, block));
    expect([...img.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...img.data.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
  });

  it('decodes DXT1 punch-through alpha when the texture has alpha', () => {
    const block = Buffer.alloc(8);
    block.writeUInt16LE(0x001f, 0); block.writeUInt16LE(0xf800, 2); // c0 <= c1: 3-colour mode
    block.writeUInt32LE(0b11, 4); // texel 0 = transparent
    const img = decodeBLP(blpHeader(2, 1, 0, 4, 4, block));
    expect(img.data[3]).toBe(0);
    expect(img.data[7]).toBe(255);
  });

  it('decodes palettized texels with 1-bit alpha', () => {
    const mip = Buffer.from([0, 1, 1, 0, 0b0101]);
    const img = decodeBLP(blpHeader(1, 1, 0, 2, 2, mip, [[10, 20, 30, 255], [200, 100, 50, 255]]));
    expect([...img.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...img.data.subarray(4, 8)]).toEqual([200, 100, 50, 0]);
    expect(img.data[11]).toBe(255);
  });
});

describe('PNG', () => {
  it('writes a valid signature, IEND CRC and round-trippable pixels', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePNG({ width: 2, height: 1, data });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(png.length - 4).toString('hex')).toBe('ae426082');
    const idatLen = png.readUInt32BE(33);
    const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, ...data]);
  });
});

describe('GLB', () => {
  it('produces 4-byte aligned chunks with parseable JSON', () => {
    const g = new GLTFBuilder();
    g.accessor(new Float32Array([0, 0, 0, 1, 2, 3]), 'VEC3', { minmax: true });
    g.accessor(new Uint8Array([1, 2, 3]), 'SCALAR');
    const glb = g.toGLB();
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonLen = glb.readUInt32LE(12);
    expect(jsonLen % 4).toBe(0);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
    expect(json.accessors[0].max).toEqual([1, 2, 3]);
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
  });
});

describe('DBC', () => {
  it('reads ints, floats and strings', () => {
    const strings = Buffer.from('\0Murloc\0', 'latin1');
    const rec = Buffer.alloc(12);
    rec.writeUInt32LE(7, 0); rec.writeFloatLE(1.5, 4); rec.writeUInt32LE(1, 8);
    const head = Buffer.alloc(20);
    head.write('WDBC', 0, 'latin1');
    head.writeUInt32LE(1, 4); head.writeUInt32LE(3, 8); head.writeUInt32LE(12, 12); head.writeUInt32LE(strings.length, 16);
    const d = parseDBC(Buffer.concat([head, rec, strings]));
    expect(d.u32(0, 0)).toBe(7);
    expect(d.f32(0, 1)).toBe(1.5);
    expect(d.str(0, 2)).toBe('Murloc');
  });
});
