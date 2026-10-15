// PKWare DCL "explode" decompressor (port of the algorithm in zlib's contrib/blast).
const LITLEN = [11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
  44, 173];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAXBITS = 13;

interface Huffman { count: number[]; symbol: number[] }

function construct(rep: number[]): Huffman {
  const lengths: number[] = [];
  for (const b of rep) { const n = (b >> 4) + 1, l = b & 15; for (let i = 0; i < n; i++) lengths.push(l); }
  const count = new Array<number>(MAXBITS + 1).fill(0);
  for (const l of lengths) count[l]++;
  const offs = new Array<number>(MAXBITS + 1).fill(0);
  for (let l = 1; l < MAXBITS; l++) offs[l + 1] = offs[l] + count[l];
  const symbol = new Array<number>(lengths.length);
  lengths.forEach((l, s) => { if (l) symbol[offs[l]++] = s; });
  return { count, symbol };
}
const LITCODE = construct(LITLEN), LENCODE = construct(LENLEN), DISTCODE = construct(DISTLEN);

export function explode(input: Buffer, outLen: number): Buffer {
  let pos = 2, bitbuf = 0, bitcnt = 0;
  const bit = () => {
    if (bitcnt === 0) {
      if (pos >= input.length) throw new Error('explode: out of input');
      bitbuf = input[pos++]; bitcnt = 8;
    }
    const b = bitbuf & 1; bitbuf >>= 1; bitcnt--; return b;
  };
  const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v; };
  const decode = (h: Huffman) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= bit() ^ 1;
      const c = h.count[len];
      if (code < first + c) return h.symbol[index + code - first];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('explode: bad code');
  };
  const lit = input[0], dict = input[1];
  if (lit > 1 || dict < 4 || dict > 6) throw new Error('explode: bad header');
  const out = Buffer.alloc(outLen);
  let o = 0;
  while (o < outLen) {
    if (bit()) {
      const sym = decode(LENCODE);
      const len = BASE[sym] + bits(EXTRA[sym]);
      if (len === 519) break;
      const sh = len === 2 ? 2 : dict;
      const dist = (decode(DISTCODE) << sh) + bits(sh) + 1;
      for (let i = 0; i < len && o < outLen; i++, o++) out[o] = out[o - dist];
    } else {
      out[o++] = lit ? decode(LITCODE) : bits(8);
    }
  }
  return out.subarray(0, o);
}
