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
    classes: [{ id: 1, name: 'Fighter' }, { id: 8, name: 'Testmage' }],
    raceClasses: { 1: [1, 8], 2: [1] },
    spells: {
      // Fighter (class 1, rage)
      901: { id: 901, name: 'Test Strike', rank: 'Rank 1', icon: 'strike', chain: 901, family: 4, familyFlags: 64, school: 0, dmgClass: 2, power: 'rage', cost: 150, castMs: 0,
        cooldownMs: 0, gcdMs: 0, durationMs: 0, spellLevel: 1, maxLevel: 0, nextSwing: true, effects: [{ k: 'weapon', flat: 11, pct: 0 }] },
      902: { id: 902, name: 'Test Shout', rank: 'Rank 1', icon: 'shout', chain: 902, family: 4, familyFlags: 65536, school: 0, dmgClass: 1, power: 'rage', cost: 100, castMs: 0,
        cooldownMs: 0, gcdMs: 1500, durationMs: 120_000, spellLevel: 1, maxLevel: 0, nextSwing: false, effects: [{ k: 'buff', stat: 'ap', amount: 20, perLevel: 0 }] },
      // Testmage (class 8, mana)
      911: { id: 911, name: 'Test Bolt', rank: 'Rank 1', icon: 'bolt', chain: 911, family: 3, familyFlags: 1, school: 2, dmgClass: 1, power: 'mana', cost: 25, castMs: 1500,
        cooldownMs: 0, gcdMs: 1500, durationMs: 0, spellLevel: 1, maxLevel: 10, nextSwing: false, effects: [{ k: 'damage', base: 14, dice: 8, perLevel: 1, perCombo: 0 }] },
      912: { id: 912, name: 'Test Burn', rank: 'Rank 1', icon: 'burn', chain: 912, family: 3, familyFlags: 2, school: 2, dmgClass: 1, power: 'mana', cost: 20, castMs: 0,
        cooldownMs: 0, gcdMs: 1500, durationMs: 12_000, spellLevel: 1, maxLevel: 0, nextSwing: false, effects: [{ k: 'dot', perTick: 4, ampMs: 3000 }] },
      913: { id: 913, name: 'Test Mend', rank: 'Rank 1', icon: 'mend', chain: 913, family: 3, familyFlags: 4, school: 1, dmgClass: 1, power: 'mana', cost: 30, castMs: 1500,
        cooldownMs: 0, gcdMs: 1500, durationMs: 0, spellLevel: 1, maxLevel: 0, nextSwing: false, effects: [{ k: 'heal', base: 40, dice: 10, perLevel: 0 }] },
      914: { id: 914, name: 'Test Bolt', rank: 'Rank 2', icon: 'bolt', chain: 911, family: 3, familyFlags: 1, school: 2, dmgClass: 1, power: 'mana', cost: 40, castMs: 2000,
        cooldownMs: 0, gcdMs: 1500, durationMs: 0, spellLevel: 6, maxLevel: 12, nextSwing: false, effects: [{ k: 'damage', base: 30, dice: 10, perLevel: 1, perCombo: 0 }] },
    },
    classSpells: {
      1: [{ spell: 901, level: 1, cost: 0 }, { spell: 902, level: 1, cost: 10 }],
      8: [{ spell: 911, level: 1, cost: 0 }, { spell: 912, level: 1, cost: 0 }, { spell: 913, level: 1, cost: 0 }, { spell: 914, level: 6, cost: 100 }],
    },
    classTrainerZones: { 1: [1], 8: [1] },
    talentTabs: { 50: { id: 50, name: 'Testfire', cls: 8, order: 0, icon: 'fire', background: 'TestFire' } },
    talents: {
      1001: { id: 1001, tab: 50, row: 0, col: 0, ranks: [9101, 9102], name: 'Improved Test Bolt', icon: 'bolt', description: '',
        effects: [[{ k: 'spellMod', op: 'castTime', flat: -250, pct: 0, family: 3, mask: 1 }], [{ k: 'spellMod', op: 'castTime', flat: -500, pct: 0, family: 3, mask: 1 }]] },
      1003: { id: 1003, tab: 50, row: 0, col: 1, ranks: [9103, 9104, 9105], name: 'Test Toughness', icon: 'tough', description: '',
        effects: [[{ k: 'healthPct', pct: 5 }], [{ k: 'healthPct', pct: 10 }], [{ k: 'healthPct', pct: 15 }]] },
      1002: { id: 1002, tab: 50, row: 1, col: 0, ranks: [9106], name: 'Test Fire Power', icon: 'power', description: '',
        requires: { talent: 1001, rank: 2 }, effects: [[{ k: 'schoolDamage', schools: 4, pct: 10 }]] },
    },
    classSkills: { 1: { 43: 0, 95: 0, 162: 0, 415: 0 }, 8: { 95: 0, 162: 0, 415: 0 } }, // fighters: swords, defense, unarmed, cloth (no axes)
    skillNames: { 43: 'Swords', 44: 'Axes', 95: 'Defense', 162: 'Unarmed', 415: 'Cloth' },
    startZones: { 1: 1, 2: 2 },
    levelStats: { 1: { 1: statsFor, 8: statsFor }, 2: { 1: statsFor } },
    classStats: {
      1: Array.from({ length: 13 }, (_, l) => [20 + l * 12, 0] as [number, number]),
      8: Array.from({ length: 13 }, (_, l) => [15 + l * 9, 100 + l * 20] as [number, number]),
    },
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
      13: { id: 13, name: 'Test Axe', quality: 1, icon: 'axe', displayId: 0, class: 2, subclass: 0, invType: 13, reqLevel: 1, sellPrice: 10, buyPrice: 0, stack: 1, armor: 0, dmgMin: 4, dmgMax: 8, delayMs: 2600, stats: [] },
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
