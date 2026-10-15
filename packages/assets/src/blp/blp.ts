// BLP2 texture decoder (WoW 1.12): palettized with 0/1/4/8-bit alpha, DXT1/3/5, and raw BGRA.
export interface RGBAImage { width: number; height: number; data: Uint8Array }

export interface BLPInfo {
  width: number; height: number;
  compression: number; alphaDepth: number; alphaType: number; hasMips: boolean;
}

const HEADER = 1172;

export function blpInfo(buf: Buffer): BLPInfo {
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'BLP2') throw new Error(`unsupported texture format ${JSON.stringify(magic)}`);
  return {
    compression: buf[8], alphaDepth: buf[9], alphaType: buf[10], hasMips: buf[11] !== 0,
    width: buf.readUInt32LE(12), height: buf.readUInt32LE(16),
  };
}

/** Decodes mip level 0 into straight (non-premultiplied) RGBA8. */
export function decodeBLP(buf: Buffer): RGBAImage {
  const info = blpInfo(buf);
  const { width: w, height: h } = info;
  const off = buf.readUInt32LE(20), size = buf.readUInt32LE(84);
  const mip = buf.subarray(off, off + size);
  const out = new Uint8Array(w * h * 4);

  if (info.compression === 1) {
    const pal = buf.subarray(148, HEADER);
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const p = mip[i] * 4;
      out[i * 4] = pal[p + 2]; out[i * 4 + 1] = pal[p + 1]; out[i * 4 + 2] = pal[p];
      out[i * 4 + 3] = alphaAt(mip, n, i, info.alphaDepth);
    }
  } else if (info.compression === 2) {
    const fmt = info.alphaType === 7 ? 5 : info.alphaType === 1 ? 3 : 1;
    decodeDXT(mip, w, h, fmt, info.alphaDepth > 0, out);
  } else if (info.compression === 3) {
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = mip[i * 4 + 2]; out[i * 4 + 1] = mip[i * 4 + 1];
      out[i * 4 + 2] = mip[i * 4]; out[i * 4 + 3] = mip[i * 4 + 3];
    }
  } else {
    throw new Error(`unsupported BLP compression ${info.compression}`);
  }
  return { width: w, height: h, data: out };
}

function alphaAt(mip: Buffer, n: number, i: number, depth: number): number {
  switch (depth) {
    case 0: return 255;
    case 1: return (mip[n + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
    case 4: return ((mip[n + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
    case 8: return mip[n + i];
    default: throw new Error(`unsupported BLP alpha depth ${depth}`);
  }
}

function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeDXT(src: Buffer, w: number, h: number, fmt: 1 | 3 | 5, dxt1Alpha: boolean, out: Uint8Array): void {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const blockSize = fmt === 1 ? 8 : 16;
  const colors = new Uint8Array(16), alphas = new Uint8Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let p = (by * bw + bx) * blockSize;
    if (fmt === 3) {
      for (let i = 0; i < 16; i++) alphas[i] = ((src[p + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
      p += 8;
    } else if (fmt === 5) {
      const a0 = src[p], a1 = src[p + 1];
      const pal = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
      else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
      // 48 bits of 3-bit indices, little-endian
      let lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16);
      let hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
      for (let i = 0; i < 8; i++) { alphas[i] = pal[lo & 7]; lo >>= 3; }
      for (let i = 8; i < 16; i++) { alphas[i] = pal[hi & 7]; hi >>= 3; }
      p += 8;
    }
    const c0 = src.readUInt16LE(p), c1 = src.readUInt16LE(p + 2);
    const pal = [rgb565(c0), rgb565(c1)];
    const fourColor = fmt !== 1 || c0 > c1;
    if (fourColor) {
      pal.push(pal[0].map((v, k) => (2 * v + pal[1][k]) / 3 | 0) as [number, number, number]);
      pal.push(pal[0].map((v, k) => (v + 2 * pal[1][k]) / 3 | 0) as [number, number, number]);
    } else {
      pal.push(pal[0].map((v, k) => (v + pal[1][k]) >> 1) as [number, number, number]);
      pal.push([0, 0, 0]);
    }
    const idx = src.readUInt32LE(p + 4);
    for (let i = 0; i < 16; i++) colors[i] = (idx >>> (i * 2)) & 3;
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const o = (y * w + x) * 4, c = pal[colors[i]];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      out[o + 3] = fmt === 1 ? (!fourColor && dxt1Alpha && colors[i] === 3 ? 0 : 255) : alphas[i];
    }
  }
}
