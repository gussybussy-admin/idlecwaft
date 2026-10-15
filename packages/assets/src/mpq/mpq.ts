// Read-only MPQ (v0/v1) reader for the WoW 1.12 client. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { explode } from './explode.js';

const CRYPT = (() => {
  const t = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    for (let j = 0, idx = i; j < 5; j++, idx += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      t[idx] = (hi | (seed & 0xffff)) >>> 0;
    }
  }
  return t;
})();

export const enum HashType { TableOffset = 0, NameA = 1, NameB = 2, FileKey = 3 }

export function hashString(str: string, type: HashType): number {
  let s1 = 0x7fed7fed, s2 = 0xeeeeeeee;
  for (const c of str.toUpperCase().replace(/\//g, '\\')) {
    const ch = c.charCodeAt(0);
    s1 = (CRYPT[type * 0x100 + ch] ^ ((s1 + s2) >>> 0)) >>> 0;
    s2 = (ch + s1 + s2 + ((s2 << 5) >>> 0) + 3) >>> 0;
  }
  return s1;
}

function decryptBuf(buf: Buffer, key: number): void {
  let s2 = 0xeeeeeeee;
  const n = buf.length >>> 2;
  for (let i = 0; i < n; i++) {
    s2 = (s2 + CRYPT[0x400 + (key & 0xff)]) >>> 0;
    const ch = (buf.readUInt32LE(i * 4) ^ ((key + s2) >>> 0)) >>> 0;
    key = ((((~key << 0x15) >>> 0) + 0x11111111) >>> 0 | (key >>> 0x0b)) >>> 0;
    s2 = (ch + s2 + ((s2 << 5) >>> 0) + 3) >>> 0;
    buf.writeUInt32LE(ch, i * 4);
  }
}

const F_IMPLODE = 0x100, F_COMPRESS = 0x200, F_ENCRYPTED = 0x10000, F_FIX_KEY = 0x20000,
  F_SINGLE = 0x1000000, F_DELETE_MARKER = 0x2000000, F_EXISTS = 0x80000000;

interface HashEntry { a: number; b: number; locale: number; block: number }
export interface BlockEntry { offset: number; csize: number; size: number; flags: number }

function decompressSector(buf: Buffer, outLen: number, flags: number): Buffer {
  if (buf.length >= outLen) return buf.subarray(0, outLen);
  if (flags & F_IMPLODE) return explode(buf, outLen);
  const mask = buf[0];
  const data = buf.subarray(1);
  if (mask === 0x02) return zlib.inflateSync(data);
  if (mask === 0x08) return explode(data, outLen);
  throw new Error(`unsupported MPQ compression mask 0x${mask.toString(16)}`);
}

export class MPQ {
  readonly path: string;
  readonly formatVersion: number;
  readonly sectorSize: number;
  private readonly fd: number;
  private readonly base: number;
  private readonly hashes: HashEntry[] = [];
  private readonly blocks: BlockEntry[] = [];

  constructor(file: string) {
    this.path = file;
    this.fd = fs.openSync(file, 'r');
    const probe = Buffer.alloc(32);
    let base = 0;
    for (;; base += 512) {
      if (fs.readSync(this.fd, probe, 0, 32, base) < 32) throw new Error('no MPQ header: ' + file);
      if (probe.readUInt32LE(0) === 0x1a51504d) break;
    }
    this.base = base;
    this.formatVersion = probe.readUInt16LE(12);
    this.sectorSize = 512 << probe.readUInt16LE(14);
    const htPos = probe.readUInt32LE(16), btPos = probe.readUInt32LE(20);
    const htSize = probe.readUInt32LE(24), btSize = probe.readUInt32LE(28);
    const ht = this.readRaw(base + htPos, htSize * 16);
    decryptBuf(ht, hashString('(hash table)', HashType.FileKey));
    const bt = this.readRaw(base + btPos, btSize * 16);
    decryptBuf(bt, hashString('(block table)', HashType.FileKey));
    for (let i = 0; i < htSize; i++) {
      this.hashes.push({ a: ht.readUInt32LE(i * 16), b: ht.readUInt32LE(i * 16 + 4),
        locale: ht.readUInt16LE(i * 16 + 8), block: ht.readUInt32LE(i * 16 + 12) });
    }
    for (let i = 0; i < btSize; i++) {
      this.blocks.push({ offset: bt.readUInt32LE(i * 16), csize: bt.readUInt32LE(i * 16 + 4),
        size: bt.readUInt32LE(i * 16 + 8), flags: bt.readUInt32LE(i * 16 + 12) });
    }
  }

  close(): void { fs.closeSync(this.fd); }

  private readRaw(pos: number, len: number): Buffer {
    const b = Buffer.alloc(len);
    fs.readSync(this.fd, b, 0, len, pos);
    return b;
  }

  findBlock(name: string): BlockEntry | null {
    const n = this.hashes.length;
    const start = hashString(name, HashType.TableOffset) % n;
    const a = hashString(name, HashType.NameA), b = hashString(name, HashType.NameB);
    for (let i = start, k = 0; k < n; i = (i + 1) % n, k++) {
      const h = this.hashes[i];
      if (h.block === 0xffffffff) return null;
      if (h.a === a && h.b === b && h.block !== 0xfffffffe) return this.blocks[h.block];
    }
    return null;
  }

  /** 'file' | 'deleted' | null (not in this archive) */
  status(name: string): 'file' | 'deleted' | null {
    const blk = this.findBlock(name);
    if (!blk || !(blk.flags & F_EXISTS)) return null;
    return blk.flags & F_DELETE_MARKER ? 'deleted' : 'file';
  }

  read(name: string): Buffer | null {
    const blk = this.findBlock(name);
    if (!blk || !(blk.flags & F_EXISTS) || blk.flags & F_DELETE_MARKER) return null;
    const pos = this.base + blk.offset;
    let key = 0;
    if (blk.flags & F_ENCRYPTED) {
      key = hashString(name.split(/[\\/]/).pop()!, HashType.FileKey);
      if (blk.flags & F_FIX_KEY) key = ((key + blk.offset) ^ blk.size) >>> 0;
    }
    const compressed = blk.flags & (F_COMPRESS | F_IMPLODE);
    if (blk.flags & F_SINGLE) {
      const raw = this.readRaw(pos, blk.csize);
      if (key) decryptBuf(raw, key);
      return compressed ? decompressSector(raw, blk.size, blk.flags) : raw;
    }
    const nSectors = Math.ceil(blk.size / this.sectorSize);
    if (!compressed) {
      const raw = this.readRaw(pos, blk.size);
      if (key) for (let s = 0; s < nSectors; s++) {
        decryptBuf(raw.subarray(s * this.sectorSize, Math.min((s + 1) * this.sectorSize, blk.size)), (key + s) >>> 0);
      }
      return raw;
    }
    const table = this.readRaw(pos, (nSectors + 1) * 4);
    if (key) decryptBuf(table, (key - 1) >>> 0);
    const out = Buffer.alloc(blk.size);
    for (let s = 0; s < nSectors; s++) {
      const o0 = table.readUInt32LE(s * 4), o1 = table.readUInt32LE(s * 4 + 4);
      const sec = this.readRaw(pos + o0, o1 - o0);
      if (key) decryptBuf(sec, (key + s) >>> 0);
      const want = Math.min(this.sectorSize, blk.size - s * this.sectorSize);
      decompressSector(sec, want, blk.flags).copy(out, s * this.sectorSize);
    }
    return out;
  }

  listfile(): string[] {
    const b = this.read('(listfile)');
    return b ? b.toString('latin1').split(/[\r\n;]+/).filter(Boolean) : [];
  }

  get fileCount(): number { return this.blocks.filter(b => b.flags & F_EXISTS).length; }
}

/** A client's Data folder with 1.12 patch precedence (patch-2 > patch > base archives). */
export class ClientArchives {
  readonly archives: { name: string; mpq: MPQ }[];

  constructor(dataDir: string) {
    const names = fs.readdirSync(dataDir).filter(f => /\.mpq$/i.test(f));
    const rank = (f: string) => {
      const m = f.match(/^patch-(\d+)/i);
      return m ? 1000 + Number(m[1]) : /^patch/i.test(f) ? 1000 : 0;
    };
    names.sort((x, y) => rank(y) - rank(x));
    this.archives = names.map(n => ({ name: n, mpq: new MPQ(path.join(dataDir, n)) }));
  }

  private owner(name: string) {
    for (const a of this.archives) {
      const s = a.mpq.status(name);
      if (s) return s === 'deleted' ? null : a;
    }
    return null;
  }

  read(name: string): Buffer | null { return this.owner(name)?.mpq.read(name) ?? null; }
  has(name: string): boolean { return this.owner(name) !== null; }
  whichArchive(name: string): string | null { return this.owner(name)?.name ?? null; }

  /** Merged, lower-cased, de-duplicated listfile across archives, minus deleted entries. */
  list(filter: (n: string) => boolean = () => true): string[] {
    const seen = new Set<string>();
    for (const { mpq } of this.archives) for (const n of mpq.listfile()) seen.add(n.toLowerCase());
    return [...seen].filter(n => filter(n) && this.owner(n)).sort();
  }

  close(): void { for (const a of this.archives) a.mpq.close(); }
}
