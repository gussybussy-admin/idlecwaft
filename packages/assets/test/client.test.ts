// Integration tests against the developer's own client. Skipped when idle.config.json is absent,
// so CI and fresh clones stay green without any Blizzard data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, loadConfig } from '../src/config.js';
import { Client } from '../src/client.js';
import { parseM2 } from '../src/m2/m2.js';
import { convertCreature } from '../src/convert/creature.js';

const hasClient = fs.existsSync(path.join(findRepoRoot(), 'idle.config.json'));

describe.skipIf(!hasClient)('local 1.12.1 client', () => {
  const client = hasClient ? new Client(loadConfig().clientPath) : (null as unknown as Client);

  it('honours patch delete markers', () => {
    expect(client.archives.has('DBFilesClient\\SpellAuraNames.dbc')).toBe(false);
    expect(client.archives.whichArchive('DBFilesClient\\Spell.dbc')).toBe('patch-2.MPQ');
  });

  it('parses the Murloc M2 with consistent indices', () => {
    const m = parseM2(client.read('Creature\\Murloc\\Murloc.m2'));
    expect(m.version).toBe(256);
    expect(m.sequences.length).toBe(27);
    for (const v of m.vertices) for (const b of v.bones) expect(b).toBeLessThan(m.bones.length);
    for (const b of m.bones) expect(b.parent).toBeLessThan(m.bones.length);
    const skin = m.skins[0];
    for (const i of skin.indices) expect(i).toBeLessThan(skin.vertices.length);
    for (const q of m.bones.flatMap(b => b.rotation.values)) expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(0.01);
  });

  it('converts a Murloc display to a GLB with one clip per sequence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-assets-'));
    try {
      const e = convertCreature(client, 31, dir);
      const glb = fs.readFileSync(path.join(dir, e.file));
      const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
      expect(json.animations.length).toBe(27);
      expect(json.images.length).toBeGreaterThan(0);
      expect(json.skins[0].joints.length).toBe(62);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
