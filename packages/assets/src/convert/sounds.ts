// Sounds, on demand: the game asks for sounds/<entry>.json (a SoundEntries.dbc row) and gets the list
// of its variations plus their volume; the files themselves (sounds/<entry>-<n>.wav|mp3) are copied out
// of the player's own sound archives as they are — 1.12 ships plain PCM WAV and MP3, which browsers play.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';

export interface SoundIndex { files: string[]; volume: number }

/** SoundEntries.dbc: 0 id, 2 name, 3-12 files, 23 directory, 24 volume. */
function entry(client: Client, id: number): { files: string[]; dir: string; volume: number } | null {
  const se = client.dbc('SoundEntries');
  const r = se.rows().find(x => se.u32(x, 0) === id);
  if (r === undefined) return null;
  const files: string[] = [];
  for (let f = 3; f <= 12; f++) { const s = se.str(r, f); if (s && /\.(wav|mp3)$/i.test(s)) files.push(s); }
  return { files, dir: se.str(r, 23), volume: se.f32(r, 24) || 1 };
}

export function convertSound(client: Client, id: number, cacheDir: string): boolean {
  const e = entry(client, id);
  if (!e || !e.files.length) return false;
  const dir = path.join(cacheDir, 'sounds');
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  e.files.forEach((name, n) => {
    const buf = client.archives.read(`${e.dir}\\${name}`);
    if (!buf) return;
    const rel = `sounds/${id}-${n}.${name.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav'}`;
    fs.writeFileSync(path.join(cacheDir, rel), buf);
    out.push(rel);
  });
  if (!out.length) return false;
  const index: SoundIndex = { files: out, volume: Math.round(e.volume * 100) / 100 };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(index));
  return true;
}
