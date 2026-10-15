// Importer integration test against the developer's own client + local VMaNGOS DB.
// Skipped when either is missing, so fresh clones and CI stay green without game data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, newGame, startAction, train, buy } from '@idle/sim';
import { findRepoRoot, loadConfig } from '../src/config.js';
import { Client } from '../src/client.js';
import { buildGameData } from '../src/import/build-game-data.js';

const root = findRepoRoot();
const ready = fs.existsSync(path.join(root, 'idle.config.json'))
  && fs.existsSync(path.join(root, 'data/vmangos/db/sqlite-dump/mangos.sqlite'));

describe.skipIf(!ready)('Elwynn import', () => {
  it('builds playable Elwynn data that the sim can run', () => {
    const client = new Client(loadConfig().clientPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-import-'));
    try {
      const data = buildGameData(client, { zones: [12], cacheDir: dir, repoRoot: root });
      const z = data.zones[0];
      expect(z.name).toBe('Elwynn Forest');
      const names = z.creatures.map(c => data.creatures[c.id].name);
      expect(names).toEqual(expect.arrayContaining(['Kobold Vermin', 'Young Wolf', 'Defias Thug', 'Hogger']));
      expect(names).not.toContain('Faire Cannon Trigger'); // event / trigger NPCs are excluded
      expect(z.nodes.map(n => data.nodes[n.id].name)).toEqual(expect.arrayContaining(['Copper Vein', 'Peacebloom', 'Silverleaf']));
      expect(z.fishing?.zoneSkill).toBe(-70);
      // Stormwind's flight master is in the Stormwind City zone; Elwynn's unused "Northshire Abbey" node is dropped.
      expect(z.taxiNodes).toEqual([]);
      expect(Object.values(data.taxiNodes).find(n => n.name === 'Stormwind, Elwynn')).toMatchObject({ zone: 1519, factions: ['alliance'] });
      expect(data.creatures[113].hostile).toEqual(['alliance', 'horde']); // Stonetusk Boar: everyone's prey
      expect(data.startZones[1]).toBe(12);
      expect(Object.values(data.recipes).map(r => r.name)).toEqual(expect.arrayContaining(['Charred Wolf Meat', 'Roasted Boar Meat']));
      expect(data.items[117].food?.heal).toBe(61); // Tough Jerky: 61 health over 18 sec, as in the tooltip

      // a level 5 character can farm boars and mine copper with the imported data
      const s = newGame(data, { name: 'Test', race: 1, cls: 1, seed: 1, now: 0 });
      s.char.level = 5;
      s.gold = 1000;
      s.inventory[117] = 50; // Tough Jerky: without food, health only returns at 1 HP a minute
      expect(startAction(s, data, { kind: 'fight', creature: 113 }).ok).toBe(true);
      advance(s, data, 30 * 60_000);
      expect(s.stats.kills[113]).toBeGreaterThan(10);
      expect(train(s, data, 'mining').ok).toBe(true);
      expect(buy(s, data, 2901).ok).toBe(true);
      expect(startAction(s, data, { kind: 'gather', node: 1731 }).ok).toBe(true);
      advance(s, data, 60 * 60_000);
      expect(s.inventory[2770]).toBeGreaterThan(0); // Copper Ore
      // Talents: three warrior trees, and a real spell modifier comes through (Improved Fireball: -0.1s cast per rank).
      expect(Object.values(data.talentTabs).filter(t => t.cls === 1)).toHaveLength(3);
      const impFireball = Object.values(data.talents).find(t => t.name === 'Improved Fireball')!;
      expect(impFireball.effects[0]).toEqual([expect.objectContaining({ k: 'spellMod', op: 'castTime', flat: -100 })]);
    } finally {
      client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
