// A tiny hand-made world for tests. Invented values only: no Blizzard or VMaNGOS data in the repo.
import type { GameData, LootTable } from '../src/data.js';

const loot = (t: Partial<LootTable>): LootTable => ({ entries: [], groups: [], ...t });
const A = ['alliance'] as const, H = ['horde'] as const, BOTH = ['alliance', 'horde'] as const;

export function fixture(): GameData {
  const levels = (n: number, f: (l: number) => [number, number, number, number, number]) =>
    Array.from({ length: n + 1 }, (_, l) => f(l));
  const statsFor = levels(12, l => [22 + l, 20 + l, 22 + l, 20, 20 + Math.floor(l / 2)]);
  return {
    version: 2, builtAt: 'test', build: 5875,
    xpToNext: [0, 400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600, 8800, 10100],
    maxLevel: 12,
    races: [{ id: 1, name: 'Testling', faction: 'alliance' }, { id: 2, name: 'Grumbling', faction: 'horde' }],
    classes: [{ id: 1, name: 'Fighter' }],
    raceClasses: { 1: [1], 2: [1] },
    startZones: { 1: 1, 2: 2 },
    levelStats: { 1: { 1: statsFor }, 2: { 1: statsFor } },
    classStats: { 1: Array.from({ length: 13 }, (_, l) => [20 + l * 12, 0] as [number, number]) },
    skillRanks: {
      mining: [{ name: 'Apprentice', max: 75, reqLevel: 1, cost: 10, spellId: 1 }, { name: 'Journeyman', max: 150, reqLevel: 10, cost: 500, spellId: 2 }],
      herbalism: [{ name: 'Apprentice', max: 75, reqLevel: 1, cost: 10, spellId: 3 }],
      fishing: [{ name: 'Apprentice', max: 75, reqLevel: 1, cost: 10, spellId: 4 }],
      cooking: [{ name: 'Apprentice', max: 75, reqLevel: 1, cost: 10, spellId: 5 }],
    },
    zones: [{
      id: 1, name: 'Testwood', map: 0, x: 0, y: 0, city: false, levelMin: 1, levelMax: 3,
      creatures: [{ id: 100, spawns: 10 }, { id: 101, spawns: 1 }, { id: 102, spawns: 2 }],
      nodes: [{ id: 200, spawns: 5 }],
      fishing: { zoneSkill: -70, loot: 'fish:1' },
      vendorItems: [{ item: 10, vendor: 'Test Vendor', factions: [...BOTH] }, { item: 11, vendor: 'Test Vendor', factions: [...BOTH] },
        { item: 5, vendor: 'Test Vendor', factions: [...BOTH] }, { item: 12, vendor: 'Alliance Smith', factions: [...A] }],
      taxiNodes: [1],
    }, {
      id: 2, name: 'Grumblevale', map: 0, x: 2100, y: 0, city: false, levelMin: 1, levelMax: 3,
      creatures: [{ id: 100, spawns: 10 }], nodes: [], fishing: null, vendorItems: [], taxiNodes: [2],
    }, {
      id: 3, name: 'Far Shore', map: 1, x: 500, y: 500, city: false, levelMin: 5, levelMax: 8,
      creatures: [], nodes: [], fishing: null, vendorItems: [], taxiNodes: [],
    }],
    creatures: {
      100: { id: 100, name: 'Test Boar', subname: '', levelMin: 1, levelMax: 2, rank: 0, type: 1, displayIds: [1], attackMs: 2000,
        stats: [{ hp: 40, dmgMin: 1, dmgMax: 3, armor: 10 }, { hp: 50, dmgMin: 2, dmgMax: 3, armor: 15 }],
        goldMin: 1, goldMax: 5, loot: 'creature:100', hostile: [...BOTH] },
      101: { id: 101, name: 'Test Ogre', subname: '', levelMin: 12, levelMax: 12, rank: 1, type: 7, displayIds: [2], attackMs: 2000,
        stats: [{ hp: 2000, dmgMin: 60, dmgMax: 80, armor: 400 }], goldMin: 100, goldMax: 200, loot: null, hostile: [...BOTH] },
      102: { id: 102, name: 'Testwood Guard', subname: '', levelMin: 2, levelMax: 2, rank: 0, type: 7, displayIds: [3], attackMs: 2000,
        stats: [{ hp: 60, dmgMin: 2, dmgMax: 4, armor: 20 }], goldMin: 0, goldMax: 0, loot: null, hostile: [...H] },
    },
    items: {
      1: { id: 1, name: 'Chunk of Test Meat', quality: 1, icon: 'meat', displayId: 0, class: 7, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 4, buyPrice: 0, stack: 10, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [] },
      2: { id: 2, name: 'Test Ore', quality: 1, icon: 'ore', displayId: 0, class: 7, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 5, buyPrice: 0, stack: 20, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [] },
      3: { id: 3, name: 'Raw Testfish', quality: 1, icon: 'fish', displayId: 0, class: 7, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 1, buyPrice: 0, stack: 20, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [] },
      4: { id: 4, name: 'Old Boot', quality: 0, icon: 'boot', displayId: 0, class: 15, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 1, buyPrice: 0, stack: 1, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [] },
      5: { id: 5, name: 'Test Jerky', quality: 1, icon: 'jerky', displayId: 0, class: 0, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 1, buyPrice: 25, stack: 20, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [], food: { heal: 60, mana: 0, durationMs: 18000 } },
      6: { id: 6, name: 'Roasted Test Meat', quality: 1, icon: 'roast', displayId: 0, class: 0, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 6, buyPrice: 0, stack: 20, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [], food: { heal: 90, mana: 0, durationMs: 18000 } },
      7: { id: 7, name: 'Test Quest Tusk', quality: 1, icon: 'tusk', displayId: 0, class: 12, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 0, buyPrice: 0, stack: 20, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [] },
      10: { id: 10, name: 'Test Pick', quality: 1, icon: 'pick', displayId: 0, class: 7, subclass: 0, invType: 0, reqLevel: 0, sellPrice: 4, buyPrice: 20, stack: 1, armor: 0, dmgMin: 0, dmgMax: 0, delayMs: 0, stats: [], tool: 'mining-pick' },
      11: { id: 11, name: 'Test Pole', quality: 1, icon: 'pole', displayId: 0, class: 2, subclass: 20, invType: 17, reqLevel: 0, sellPrice: 4, buyPrice: 20, stack: 1, armor: 0, dmgMin: 1, dmgMax: 2, delayMs: 3000, stats: [], tool: 'fishing-pole' },
      12: { id: 12, name: 'Test Sword', quality: 2, icon: 'sword', displayId: 0, class: 2, subclass: 7, invType: 13, reqLevel: 2, sellPrice: 50, buyPrice: 100, stack: 1, armor: 0, dmgMin: 5, dmgMax: 9, delayMs: 2400, stats: [[4, 2]] },
    },
    nodes: { 200: { id: 200, name: 'Test Vein', skill: 'mining', reqSkill: 1, displayId: 0, loot: 'go:200' } },
    recipes: {
      300: { spellId: 300, name: 'Roasted Test Meat', skill: 'cooking', item: 6, count: 1, reagents: [[1, 1]],
        orange: 1, yellow: 45, green: 65, grey: 85, castMs: 3000, source: { trainer: 0 } },
    },
    loot: {
      'creature:100': loot({ entries: [{ item: 1, chance: 60, min: 1, max: 1 }, { item: 7, chance: 50, min: 1, max: 1, quest: true }] }),
      'go:200': loot({ entries: [{ item: 2, chance: 100, min: 1, max: 2 }] }),
      'fish:1': loot({ groups: [[{ item: 3, chance: 50, min: 1, max: 1 }, { item: 4, chance: 0, min: 1, max: 1 }]] }),
    },
    taxiNodes: {
      1: { id: 1, name: 'Testwood Roost', map: 0, x: 100, y: 0, zone: 1, factions: [...BOTH] },
      2: { id: 2, name: 'Grumblevale Perch', map: 0, x: 2000, y: 0, zone: 2, factions: [...BOTH] },
    },
    taxiPaths: [{ from: 1, to: 2, cost: 30, length: 1900 }, { from: 2, to: 1, cost: 30, length: 1900 }],
  };
}
