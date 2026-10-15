// World position -> area -> zone, read from the area id each ADT terrain chunk carries.
// This is exactly how the client knows which zone you're standing in.
import type { Client } from '../client.js';

const TILE = 1600 / 3; // 533.33 yards
const CHUNK = TILE / 16;

export class ZoneLookup {
  private tiles = new Map<string, Uint32Array | null>(); // 16x16 area ids per tile
  private parent = new Map<number, number>();
  private mapDirs = new Map<number, string>();

  constructor(private client: Client) {
    const at = client.dbc('AreaTable'); // 0 id, 1 map, 2 parent area (0 = is a zone)
    for (const r of at.rows()) this.parent.set(at.u32(r, 0), at.u32(r, 2));
    const mp = client.dbc('Map'); // 0 id, 1 directory
    for (const r of mp.rows()) this.mapDirs.set(mp.u32(r, 0), mp.str(r, 1));
  }

  /** Area id of the terrain chunk under (x, y), or 0 if there is no terrain there. */
  areaAt(map: number, x: number, y: number): number {
    const gx = 32 - y / TILE, gy = 32 - x / TILE;
    const tx = Math.floor(gx), ty = Math.floor(gy);
    if (tx < 0 || ty < 0 || tx > 63 || ty > 63) return 0;
    const areas = this.tile(map, tx, ty);
    if (!areas) return 0;
    const cx = Math.min(15, Math.floor((gx - tx) * 16)), cy = Math.min(15, Math.floor((gy - ty) * 16));
    return areas[cy * 16 + cx];
  }

  /** Top-level zone for an area (walks AreaTable parents). */
  zoneOf(area: number): number {
    let a = area;
    for (let i = 0; i < 8; i++) { const p = this.parent.get(a); if (!p) return a; a = p; }
    return a;
  }

  zoneAt(map: number, x: number, y: number): number {
    const area = this.areaAt(map, x, y);
    return area ? this.zoneOf(area) : 0;
  }

  private tile(map: number, tx: number, ty: number): Uint32Array | null {
    const key = `${map}:${tx}:${ty}`;
    if (this.tiles.has(key)) return this.tiles.get(key)!;
    const dir = this.mapDirs.get(map);
    const buf = dir ? this.client.archives.read(`World\\Maps\\${dir}\\${dir}_${tx}_${ty}.adt`) : null;
    const areas = buf ? readChunkAreas(buf) : null;
    this.tiles.set(key, areas);
    return areas;
  }
}

/** Reads MCIN -> MCNK headers and returns area ids indexed [indexY * 16 + indexX]. */
function readChunkAreas(buf: Buffer): Uint32Array {
  const out = new Uint32Array(256);
  let p = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'NICM') { // 'MCIN' stored reversed
      for (let i = 0; i < 256; i++) {
        const off = buf.readUInt32LE(p + 8 + i * 16);
        if (!off || buf.toString('latin1', off, off + 4) !== 'KNCM') continue;
        const h = off + 8;
        const ix = buf.readUInt32LE(h + 4), iy = buf.readUInt32LE(h + 8);
        out[iy * 16 + ix] = buf.readUInt32LE(h + 0x34);
      }
      break;
    }
    p += 8 + size;
  }
  return out;
}

export { TILE, CHUNK };
