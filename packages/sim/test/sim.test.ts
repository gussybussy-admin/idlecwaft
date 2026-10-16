import { describe, expect, it } from 'vitest';
import {
  advance, buy, catchUp, equip, gatherColor, grayLevel, killXp, newGame, OFFLINE_CAP_MS, planTravel, playerStats,
  rollLoot, RUN_SPEED, seedRng, sell, startAction, stopAction, train, trainRiding, trainSpells, knownSpells,
  learnTalent, pointsSpent, modded, activeTalentEffects, resetTalents, resetCost,
  disenchant, unlearnProfession, attunementError, POISON_INSTANT, UNHAPPY, petStats, itemCategory, bagSpace, roomFor, equipBag, giveItem, activePet, rangedStats, dungeonLoot, nextReset, withRaidBuffs, groupRoles, simulateRun, snapshotOf, measureDps, canUse, type Role, type RunResult, type Snapshot, acceptQuest, abandonQuest, completeQuest, questComplete, availableQuests, standing, repRank, migrateState, applyCommand, parseCommand,
  type GameState, type SimEvent,
} from '../src/index.js';
import { fixture } from './fixture.js';

const data = fixture();
const T0 = 1_700_000_000_000;
const fresh = (seed = 42): GameState => newGame(data, { name: 'Tester', race: 1, cls: 1, seed, now: T0 });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('formulas', () => {
  it('matches MaNGOS kill XP and gray levels', () => {
    expect(killXp(1, 1)).toBe(50);
    expect(killXp(10, 10)).toBe(95);
    expect(killXp(10, 14)).toBe(Math.floor(((10 * 5 + 45) * 24 / 10 + 1) / 2));
    expect(killXp(10, 12, 1)).toBe(2 * killXp(10, 12));
    expect(grayLevel(10)).toBe(4);
    expect(killXp(10, 4)).toBe(0);
  });

  it('colours gathering by required skill', () => {
    expect(gatherColor(0, 1)).toBe('red');
    expect(gatherColor(1, 1)).toBe('orange');
    expect(gatherColor(30, 1)).toBe('yellow');
    expect(gatherColor(60, 1)).toBe('green');
    expect(gatherColor(101, 1)).toBe('grey');
  });
});

describe('loot', () => {
  it('picks evenly among 0-chance group entries when no explicit entry hits', () => {
    const rng = seedRng(7);
    const counts = { 3: 0, 4: 0 };
    for (let i = 0; i < 4000; i++) for (const [item] of rollLoot(data, data.zones[0].fishing!.loot, rng)) counts[item as 3 | 4]++;
    expect(counts[3] + counts[4]).toBe(4000); // a group always yields exactly one entry here
    expect(counts[3] / 4000).toBeGreaterThan(0.45);
    expect(counts[3] / 4000).toBeLessThan(0.55);
  });
});

describe('travel, flight paths and factions', () => {
  it('walks to a new zone in minutes, discovers its flight path, and flies back faster for a fee', () => {
    const s = fresh();
    expect(s.zone).toBe(1);
    expect(s.taxi).toEqual([1]); // the start zone's flight master is known
    const walk = planTravel(s, data, 2)!;
    expect(walk.legs.map(l => l.kind)).toEqual(['walk']);
    expect(walk.ms).toBe(Math.round(2100 / RUN_SPEED * 1000)); // 5 minutes at run speed
    expect(startAction(s, data, { kind: 'travel', to: 2 }).ok).toBe(true);
    advance(s, data, T0 + walk.ms + 1000);
    expect(s.zone).toBe(2);
    expect(s.taxi).toEqual([1, 2]);
    expect(s.action).toBeNull();
    s.gold = 100;
    const fly = planTravel(s, data, 1)!;
    expect(fly.legs[0].kind).toBe('fly');
    expect(fly.ms).toBeLessThan(walk.ms / 2);
    expect(fly.cost).toBe(30);
    startAction(s, data, { kind: 'travel', to: 1 });
    advance(s, data, s.now + fly.ms + 1000);
    expect(s.zone).toBe(1);
    expect(s.gold).toBe(70);
  });

  it('riding shortens travel; there is no route to a continent without a crossing', () => {
    const s = fresh();
    const before = planTravel(s, data, 2)!.ms;
    s.char.level = 12; s.gold = 100_0000;
    expect(trainRiding(s)).toEqual({ ok: false, error: 'Requires level 40.' });
    s.char.level = 40;
    expect(trainRiding(s).ok).toBe(true);
    expect(planTravel(s, data, 2)!.ms).toBe(Math.round(before / 1.6));
    expect(startAction(s, data, { kind: 'travel', to: 3 })).toEqual({ ok: false, error: 'There is no way to get there from here.' });
  });

  it('respects faction: who you can attack and who will trade with you', () => {
    const ally = fresh(), horde = newGame(data, { name: 'Grum', race: 2, cls: 1, seed: 1, now: T0 });
    expect(horde.zone).toBe(2);
    horde.zone = 1;
    expect(startAction(ally, data, { kind: 'fight', creature: 102 })).toEqual({ ok: false, error: 'You cannot attack that.' });
    expect(startAction(horde, data, { kind: 'fight', creature: 102 }).ok).toBe(true);
    ally.gold = horde.gold = 1000;
    ally.rep[72] = 3000; // the smith wants Friendly standing
    expect(buy(ally, data, 12).ok).toBe(true);
    expect(buy(horde, data, 12).ok).toBe(false);
  });

  it('never drops quest-only items without the quest', () => {
    const rng = seedRng(3);
    let tusks = 0;
    for (let i = 0; i < 500; i++) tusks += rollLoot(data, 'creature:100', rng).get(7) ?? 0;
    expect(tusks).toBe(0);
    let withQuest = 0;
    for (let i = 0; i < 500; i++) withQuest += rollLoot(data, 'creature:100', rng, new Set([7])).get(7) ?? 0;
    expect(withQuest).toBeGreaterThan(150);
  });
});

describe('weapon skills and defense', () => {
  it('raises the skill of the weapon in hand and Defense while fighting, capped at 5 x level', () => {
    const s = fresh();
    s.inventory[5] = 300;
    s.char.level = 2;
    s.inventory[12] = 1;
    expect(equip(s, data, 12).ok).toBe(true);
    expect(s.combatSkills[43]).toBe(1); // a new weapon type starts at 1
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 20 * 60_000);
    const cap = s.char.level * 5;
    expect(s.combatSkills[43]).toBeGreaterThan(5);
    expect(s.combatSkills[43]).toBeLessThanOrEqual(cap);
    expect(s.combatSkills[95]).toBeGreaterThan(1);
    expect(s.combatSkills[162]).toBe(1); // unarmed didn't move while a sword was in hand
  });

  it('only lets a class equip weapons it can learn', () => {
    const s = fresh();
    s.inventory[13] = 1;
    expect(equip(s, data, 13)).toEqual({ ok: false, error: "Fighters can't use Axes." });
  });
});

describe('class spells', () => {
  const mage = (seed = 5) => newGame(data, { name: 'Zap', race: 1, cls: 8, seed, now: T0 });

  it('starts with its free level-1 spells and full mana', () => {
    const s = mage();
    expect(s.spells.sort()).toEqual([911, 912, 913]);
    expect(s.char.mana).toBeGreaterThan(100);
  });

  it('a caster fights with its spells: nukes, keeps its damage-over-time up, heals when low, and spends mana', () => {
    const s = mage();
    s.inventory[5] = 300;
    const spellsUsed = new Set<number>(), heals: number[] = [];
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 30 * 60_000, e => {
      if (e.type === 'swing' && e.who === 'player' && e.spell) spellsUsed.add(e.spell);
      if (e.type === 'heal') heals.push(e.spell);
    });
    expect(spellsUsed.has(911)).toBe(true);
    expect(spellsUsed.has(912)).toBe(true);
    expect(s.stats.kills[100]).toBeGreaterThan(10);
  });

  it('spells make a caster far stronger than auto-attacks alone', () => {
    const withSpells = mage(), without = mage();
    without.spells = [];
    for (const s of [withSpells, without]) { s.inventory[5] = 300; startAction(s, data, { kind: 'fight', creature: 100 }); advance(s, data, T0 + 30 * 60_000); }
    expect(withSpells.stats.kills[100]).toBeGreaterThan(1.5 * (without.stats.kills[100] ?? 0));
  });

  it('a fighter builds rage from swings and spends it on its next-swing strike', () => {
    const s = fresh();
    s.inventory[5] = 300;
    let strikes = 0, peakRage = 0;
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 15 * 60_000, e => {
      if (e.type === 'swing' && e.spell === 901) strikes++;
      peakRage = Math.max(peakRage, s.char.rage ?? 0);
    });
    expect(peakRage).toBeGreaterThan(150);
    expect(strikes).toBeGreaterThan(0);
  });

  it('trains new ranks only at a class trainer, by level, while the money lasts', () => {
    const s = mage();
    s.zone = 2;
    expect(trainSpells(s, data)).toEqual({ ok: false, error: "There's no testmage trainer here." });
    s.zone = 1;
    expect(trainSpells(s, data)).toEqual({ ok: false, error: 'You have nothing new to learn yet.' });
    s.char.level = 6;
    expect(trainSpells(s, data)).toEqual({ ok: false, error: 'Training costs 1s.' });
    s.gold = 150;
    expect(trainSpells(s, data).ok).toBe(true);
    expect(s.spells).toContain(914);
    expect(s.gold).toBe(50);
    expect(knownSpells(s, data).find(sp => sp.chain === 911)?.rank).toBe('Rank 2'); // highest rank is used
  });

  it('known buffs are always on: the shout raises attack power once learned', () => {
    const s = fresh();
    const before = playerStats(s, data).ap;
    s.spells.push(902);
    expect(playerStats(s, data).ap).toBe(before + 20);
  });

  it('casters are chunk-independent too (mana ticks, casts and damage-over-time)', () => {
    const big = mage(9), small = mage(9);
    for (const s of [big, small]) { s.inventory[5] = 300; startAction(s, data, { kind: 'fight', creature: 100 }); }
    advance(big, data, T0 + 3_600_000);
    for (let t = T0; t < T0 + 3_600_000; t += 913) advance(small, data, t);
    advance(small, data, T0 + 3_600_000);
    expect(small).toEqual(big);
  });
});

describe('talents', () => {
  const mage = () => newGame(data, { name: 'Zap', race: 1, cls: 8, seed: 5, now: T0 });

  it('follows the vanilla rules: a point per level from 10, rows need 5 points, prerequisites', () => {
    const s = mage();
    expect(learnTalent(s, data, 1003)).toEqual({ ok: false, error: 'Talents start at level 10.' });
    s.char.level = 15; // 6 points
    expect(learnTalent(s, data, 1002)).toEqual({ ok: false, error: 'Requires 5 points in Testfire.' });
    for (let i = 0; i < 3; i++) expect(learnTalent(s, data, 1003).ok).toBe(true);
    expect(learnTalent(s, data, 1003)).toEqual({ ok: false, error: 'Already at the highest rank.' });
    expect(learnTalent(s, data, 1001).ok).toBe(true);
    expect(learnTalent(s, data, 1002)).toEqual({ ok: false, error: 'Requires 5 points in Testfire.' });
    expect(learnTalent(s, data, 1001).ok).toBe(true); // 5 points in the tree, prerequisite at rank 2
    expect(learnTalent(s, data, 1002).ok).toBe(true);
    expect(learnTalent(s, data, 1003)).toEqual({ ok: false, error: 'Already at the highest rank.' });
    expect(pointsSpent(s)).toBe(6);
  });

  it("applies real effects: health %, a spell's cast time, school damage", () => {
    const s = mage();
    s.char.level = 15;
    const hp = playerStats(s, data).maxHp;
    for (let i = 0; i < 3; i++) learnTalent(s, data, 1003);
    expect(playerStats(s, data).maxHp).toBe(Math.round(hp * 1.15));
    learnTalent(s, data, 1001); learnTalent(s, data, 1001);
    const bolt = data.spells[911];
    expect(modded(bolt, activeTalentEffects(s, data)).castMs).toBe(1000);
    learnTalent(s, data, 1002);
    expect(modded(bolt, activeTalentEffects(s, data)).dmgMult).toBeCloseTo(1.1);
    expect(modded(data.spells[913], activeTalentEffects(s, data)).dmgMult).toBe(1); // Test Mend is holy, not fire
  });

  it('resets for a rising fee', () => {
    const s = mage();
    s.char.level = 12; s.gold = 100_000;
    learnTalent(s, data, 1003);
    expect(resetTalents(s).ok).toBe(true);
    expect(s.gold).toBe(90_000);
    expect(pointsSpent(s)).toBe(0);
    learnTalent(s, data, 1003);
    expect(resetCost(s)).toBe(50_000);
  });
});

describe('determinism', () => {
  it('two identical states advanced to the same time are identical', () => {
    const a = fresh(), b = fresh();
    startAction(a, data, { kind: 'fight', creature: 100 });
    startAction(b, data, { kind: 'fight', creature: 100 });
    advance(a, data, T0 + 3_600_000);
    advance(b, data, T0 + 3_600_000);
    expect(a).toEqual(b);
  });

  it('advancing in many small chunks equals one big advance (online == offline)', () => {
    const big = fresh(), small = fresh();
    for (const s of [big, small]) { s.gold = 1000; train(s, data, 'cooking'); startAction(s, data, { kind: 'fight', creature: 100 }); }
    advance(big, data, T0 + 2 * 3_600_000);
    for (let t = T0; t < T0 + 2 * 3_600_000; t += 777) advance(small, data, t);
    advance(small, data, T0 + 2 * 3_600_000);
    expect(small).toEqual(big);
  });

  it('a different seed gives a different outcome', () => {
    const a = fresh(1), b = fresh(2);
    startAction(a, data, { kind: 'fight', creature: 100 });
    startAction(b, data, { kind: 'fight', creature: 100 });
    advance(a, data, T0 + 3_600_000);
    advance(b, data, T0 + 3_600_000);
    expect(a.rng).not.toEqual(b.rng);
  });
});

describe('offline progress', () => {
  it('caps catch-up at 24 hours and lands exactly at wall time', () => {
    const s = fresh();
    startAction(s, data, { kind: 'fight', creature: 100 });
    const wall = T0 + 30 * 3_600_000;
    const sum = catchUp(s, data, wall);
    expect(sum.ms).toBe(OFFLINE_CAP_MS);
    expect(s.now).toBe(wall);
    expect(sum.kills).toBeGreaterThan(100);
    expect(sum.xp).toBeGreaterThan(0);
  });

  it('catch-up equals the same window simulated online', () => {
    const online = fresh(), offline = fresh();
    for (const s of [online, offline]) startAction(s, data, { kind: 'fight', creature: 100 });
    advance(online, data, T0 + 10 * 3_600_000);
    catchUp(offline, data, T0 + 10 * 3_600_000);
    expect(offline).toEqual(online);
  });
});

describe('combat', () => {
  it('food is what keeps a fighter going: natural regen is only 1 HP a minute', () => {
    const fed = fresh(), hungry = fresh();
    fed.inventory[5] = 200; // Test Jerky
    for (const s of [fed, hungry]) startAction(s, data, { kind: 'fight', creature: 100 });
    advance(fed, data, T0 + 3_600_000);
    advance(hungry, data, T0 + 3_600_000);
    const kills = (s: GameState) => s.stats.kills[100] ?? 0;
    expect(kills(fed)).toBeGreaterThan(3 * kills(hungry));
    expect(fed.inventory[5]).toBeLessThan(200);
    // Out of combat with no food, health comes back one point per minute.
    const idle = fresh();
    idle.char.hp = 10;
    advance(idle, data, idle.now + 10 * 60_000);
    expect(idle.char.hp).toBeGreaterThanOrEqual(19);
    expect(idle.char.hp).toBeLessThanOrEqual(20);
  });

  it('a level 1 fighter with food farms level 1-2 boars and levels up', () => {
    const s = fresh();
    s.inventory[5] = 200;
    const events: SimEvent[] = [];
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 3_600_000, e => events.push(e));
    expect(s.char.level).toBeGreaterThan(3);
    expect(events.some(e => e.type === 'kill')).toBe(true);
    expect(s.gold).toBeGreaterThan(0);
    expect(s.stats.deaths).toBe(0);
  });

  it('dies to an overwhelming elite, resurrects and keeps going', () => {
    const s = fresh();
    startAction(s, data, { kind: 'fight', creature: 101 });
    advance(s, data, T0 + 10 * 60_000);
    expect(s.stats.deaths).toBeGreaterThan(0);
    expect(s.char.hp).toBeGreaterThanOrEqual(0);
    expect(s.action?.kind).toBe('fight');
  });

  it('eats food while resting', () => {
    const s = fresh();
    s.inventory[5] = 5;
    s.settings.eatBelowPct = 99; // easy boars rarely push a fighter below the default 50%
    s.settings.restBelowPct = 99;
    const events: SimEvent[] = [];
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 30 * 60_000, e => events.push(e));
    expect(events.some(e => e.type === 'eat')).toBe(true);
    expect(s.inventory[5] ?? 0).toBeLessThan(5);
  });
});

describe('item categories', () => {
  it('sorts items by what they are for', () => {
    const cat = (id: number) => itemCategory(data, data.items[id]);
    expect([cat(12), cat(23), cat(5), cat(22), cat(2), cat(10), cat(11), cat(5956), cat(7), cat(4)])
      .toEqual(['Weapons', 'Armor', 'Consumables', 'Consumables', 'Trade Goods', 'Tools', 'Tools', 'Tools', 'Quest Items', 'Junk']);
  });
});

describe('quests and reputation', () => {
  it('kill quest: accept, credit kills, hand in for a chosen reward, unlock the follow-up', () => {
    const s = fresh();
    s.inventory[5] = 20;
    expect(availableQuests(s, data).map(q => q.id)).toEqual([400, 402]); // 401 needs 400 first
    expect(acceptQuest(s, data, 400).ok).toBe(true);
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 20 * 60_000);
    expect(questComplete(s, data, 400)).toBe(true);
    stopAction(s);
    expect(completeQuest(s, data, 400)).toEqual({ ok: false, error: 'Choose a reward.' });
    const xp0 = s.char.xp, lvl0 = s.char.level, gold0 = s.gold, rep0 = standing(s, data, 72);
    expect(completeQuest(s, data, 400, 13).ok).toBe(true);
    expect(s.inventory[13]).toBe(1);
    expect(s.gold).toBe(gold0 + 50);
    expect(s.char.level > lvl0 || s.char.xp > xp0).toBe(true);
    expect(standing(s, data, 72)).toBe(rep0 + 250);
    expect(availableQuests(s, data).map(q => q.id)).toContain(401);
  });

  it('quest-only drops roll only while the quest needs them', () => {
    const s = fresh();
    s.inventory[5] = 20;
    s.questsDone.push(400);
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 10 * 60_000);
    expect(s.inventory[7]).toBeUndefined();
    acceptQuest(s, data, 401);
    advance(s, data, T0 + 30 * 60_000);
    expect(s.inventory[7]).toBe(3); // stops at what the quest needs
    stopAction(s);
    expect(completeQuest(s, data, 401).ok).toBe(true);
    expect(s.inventory[7]).toBeUndefined();
  });

  it('timed task quests run as an action and are handed in at the ender', () => {
    const s = fresh();
    expect(acceptQuest(s, data, 402).ok).toBe(true);
    expect(startAction(s, data, { kind: 'quest', quest: 402 }).ok).toBe(true);
    advance(s, data, T0 + 60_000);
    expect(questComplete(s, data, 402)).toBe(false);
    advance(s, data, T0 + 2 * 60_000);
    expect(questComplete(s, data, 402)).toBe(true);
    expect(s.action).toBeNull();
    expect(completeQuest(s, data, 402).ok).toBe(false); // the ender is in Grumblevale
    s.zone = 2;
    expect(completeQuest(s, data, 402).ok).toBe(true);
    expect(abandonQuest(s, data, 402).ok).toBe(false);
  });

  it('kill reputation stops at its cap, and reputation gates vendor items', () => {
    const s = fresh();
    s.gold = 1000;
    s.char.level = 2;
    expect(buy(s, data, 12)).toEqual({ ok: false, error: 'Requires Friendly with Testwind.' });
    s.inventory[5] = 50;
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 6 * 3_600_000);
    expect(standing(s, data, 72)).toBe(8999); // top of Friendly, the boars' max
    expect(repRank(standing(s, data, 72))).toBe(4);
    stopAction(s);
    expect(buy(s, data, 12).ok).toBe(true);
    const horde = newGame(data, { name: 'Grunt', race: 2, cls: 1, seed: 1, now: T0 });
    expect(repRank(standing(horde, data, 72))).toBe(0); // Hated
  });
});

describe('professions and commands', () => {
  it('mining needs training and a pick, then skills up to the rank cap', () => {
    const s = fresh();
    expect(startAction(s, data, { kind: 'gather', node: 200 })).toEqual({ ok: false, error: 'You need to train Mining first.' });
    s.gold = 100;
    expect(train(s, data, 'mining').ok).toBe(true);
    expect(startAction(s, data, { kind: 'gather', node: 200 }).ok).toBe(false); // no pick
    expect(buy(s, data, 10).ok).toBe(true);
    expect(startAction(s, data, { kind: 'gather', node: 200 }).ok).toBe(true);
    advance(s, data, T0 + 24 * 3_600_000);
    expect(s.skills.mining.level).toBe(75);
    expect(s.inventory[2]).toBeGreaterThan(100);
  });

  it('cooking consumes reagents and stops when they run out', () => {
    const s = fresh();
    s.gold = 100;
    train(s, data, 'cooking');
    s.inventory[1] = 5;
    expect(startAction(s, data, { kind: 'craft', recipe: 300 }).ok).toBe(true);
    advance(s, data, T0 + 60_000);
    expect(s.inventory[1]).toBeUndefined();
    expect(s.inventory[6]).toBe(5);
    expect(s.action).toBeNull();
    expect(s.skills.cooking.level).toBeGreaterThan(1);
  });

  it('Apprentice Cooking, Fishing and First Aid are free from level 1; primaries keep their price', () => {
    const s = fresh();
    expect(s.gold).toBe(0);
    for (const p of ['cooking', 'fishing', 'firstaid'] as const) expect(train(s, data, p).ok).toBe(true);
    expect(train(s, data, 'mining')).toEqual({ ok: false, error: 'Costs 10c.' });
    expect(s.inventory[11]).toBe(1); // a Fishing Pole from the trainer
    expect(startAction(s, data, { kind: 'fish' }).ok).toBe(true);
    // Learned Fishing before poles were handed out: the first cast brings one, once.
    const old = fresh();
    old.skills.fishing = { level: 1, max: 75 };
    expect(startAction(old, data, { kind: 'fish' }).ok).toBe(true);
    expect(old.inventory[11]).toBe(1);
    delete old.inventory[11];
    expect(startAction(old, data, { kind: 'fish' }).ok).toBe(false);
  });

  it('only two primary professions at a time; unlearning frees a slot', () => {
    const s = fresh();
    s.gold = 1000;
    expect(train(s, data, 'mining').ok).toBe(true);
    expect(train(s, data, 'skinning').ok).toBe(true);
    expect(train(s, data, 'cooking').ok).toBe(true); // secondary
    expect(train(s, data, 'blacksmithing')).toEqual({ ok: false, error: 'You already know 2 primary professions. Unlearn one first.' });
    expect(unlearnProfession(s, data, 'skinning').ok).toBe(true);
    expect(train(s, data, 'blacksmithing').ok).toBe(true);
    expect(s.recipes).toContain(310);
  });

  it('crafting needs its tool, and a count stops the action', () => {
    const s = fresh();
    s.gold = 1000;
    train(s, data, 'blacksmithing');
    s.inventory[2] = 10;
    expect(startAction(s, data, { kind: 'craft', recipe: 310, count: 3 })).toEqual({ ok: false, error: 'Requires Blacksmith Hammer.' });
    s.inventory[5956] = 1;
    expect(startAction(s, data, { kind: 'craft', recipe: 310, count: 3 }).ok).toBe(true);
    advance(s, data, T0 + 60_000);
    expect(s.inventory[5]).toBe(3);
    expect(s.inventory[2]).toBe(7);
    expect(s.action).toBeNull();
    expect(s.stats.crafted).toBe(3);
  });

  it('skins beasts after the kill with a knife, raising Skinning', () => {
    const s = fresh();
    s.gold = 1000;
    s.inventory[5] = 20;
    train(s, data, 'skinning');
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 10 * 60_000);
    expect(s.inventory[20]).toBeUndefined(); // no knife yet
    s.inventory[7005] = 1;
    advance(s, data, T0 + 40 * 60_000);
    expect(s.inventory[20]).toBeGreaterThan(5);
    expect(s.skills.skinning.level).toBeGreaterThan(1);
  });

  it('disenchants greens and enchants an equipped item', () => {
    const s = fresh();
    s.gold = 1000;
    s.char.level = 2;
    s.inventory[12] = 1; s.inventory[23] = 1;
    expect(disenchant(s, data, 12).ok).toBe(false); // no enchanting yet
    train(s, data, 'enchanting');
    expect(disenchant(s, data, 12).ok).toBe(true);
    expect(s.inventory[21]).toBe(2);
    expect(startAction(s, data, { kind: 'craft', recipe: 320, count: 1 }).ok).toBe(false); // nothing to enchant
    equip(s, data, 23);
    const hp0 = playerStats(s, data).maxHp;
    expect(startAction(s, data, { kind: 'craft', recipe: 320, count: 1 }).ok).toBe(true);
    advance(s, data, T0 + 30_000);
    expect(s.enchants.wrist).toBe(41);
    expect(playerStats(s, data).maxHp).toBe(hp0 + 25);
    expect(s.inventory[21]).toBe(1);
  });

  it('drinks a healing potion when a fight goes badly', () => {
    const s = fresh();
    s.inventory[22] = 3;
    s.inventory[5] = 5;
    let healed = 0;
    startAction(s, data, { kind: 'fight', creature: 101 }); // the elite ogre
    advance(s, data, T0 + 5 * 60_000, e => { if (e.type === 'heal' && e.item === 22) healed++; });
    expect(healed).toBeGreaterThan(0);
    expect(s.inventory[22] ?? 0).toBeLessThan(3);
  });

  it('old saves migrate: new skills, cook actions become craft', () => {
    const s = fresh() as unknown as Record<string, unknown> & GameState;
    s.skills = { mining: { level: 3, max: 75 } } as GameState['skills'];
    (s as { action: unknown }).action = { kind: 'cook', recipe: 300 };
    delete (s as Partial<GameState>).enchants;
    migrateState(s);
    expect(s.skills.mining.level).toBe(3);
    expect(s.skills.tailoring).toEqual({ level: 0, max: 0 });
    expect(s.action).toEqual({ kind: 'craft', recipe: 300 });
    expect(s.enchants).toEqual({});
    expect(parseCommand({ name: 'start', action: { kind: 'craft', recipe: 310, count: 2, slot: 'wrist' } }))
      .toEqual({ name: 'start', action: { kind: 'craft', recipe: 310, count: 2, slot: 'wrist' } });
    expect(applyCommand(s, data, { name: 'unlearn', skill: 'mining' }).ok).toBe(true);
  });

  it('fishing with a pole catches fish or boots', () => {
    const s = fresh();
    s.gold = 100;
    train(s, data, 'fishing');
    buy(s, data, 11);
    s.settings.autoDeposit = false;
    expect(startAction(s, data, { kind: 'fish' }).ok).toBe(true);
    const events: SimEvent[] = [];
    advance(s, data, T0 + 3_600_000, e => events.push(e));
    expect((s.inventory[3] ?? 0) + (s.inventory[4] ?? 0)).toBeGreaterThan(20);
    // Boots don't stack: the 16-slot backpack fills up, and fishing stops.
    expect(bagSpace(s, data).used).toBe(16);
    expect(events.some(e => e.type === 'stop' && e.reason === 'Your bags are full.')).toBe(true);
    expect(s.action).toBeNull();
  });

  it('equipping a weapon raises damage; selling pays copper', () => {
    const s = fresh();
    s.char.level = 2;
    s.inventory[12] = 1;
    const before = playerStats(s, data);
    expect(equip(s, data, 12).ok).toBe(true);
    const after = playerStats(s, data);
    expect(after.dmgMax).toBeGreaterThan(before.dmgMax);
    expect(after.str).toBe(before.str + 2);
    s.inventory[1] = 3;
    expect(sell(s, data, 1, 3).ok).toBe(true);
    expect(s.gold).toBe(12);
  });

  it('stopping clears the action', () => {
    const s = fresh();
    startAction(s, data, { kind: 'fight', creature: 100 });
    advance(s, data, T0 + 60_000);
    expect(stopAction(s).ok).toBe(true);
    expect(s.action).toBeNull();
    const snapshot = clone(s);
    advance(s, data, T0 + 120_000);
    expect(s.inventory).toEqual(snapshot.inventory);
  });
});

describe('dungeons: the group simulation', () => {
  const dungeon = data.dungeons[1];
  const char = (cls: number, level = 12) => {
    const s = newGame(data, { name: cls === 1 ? 'Tanky' : 'Mendy', race: 1, cls, seed: 3, now: T0 });
    s.char.level = level;
    s.spells = (data.classSpells[cls] ?? []).map(o => o.spell);
    s.combatSkills = { 95: level * 5, 162: level * 5, 43: level * 5 };
    return s;
  };
  const group = (roles: Role[]) => roles.map((role, i) =>
    snapshotOf(char(role === 'tank' ? 1 : 8), data, 100 + i, role, 12));

  it('measures damage per second with the real fight engine', () => {
    expect(measureDps(char(1), data, 12)).toBeGreaterThan(5);
    expect(measureDps(char(8), data, 12)).toBeGreaterThan(5);
  });

  it('is deterministic: same snapshots and seed give the same run', () => {
    const g = group(['tank', 'healer', 'dps', 'dps', 'dps']);
    const a = simulateRun(data, dungeon, g, 7), b = simulateRun(data, dungeon, clone(g), 7);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(simulateRun(data, dungeon, g, 8).events)).not.toBe(JSON.stringify(a.events));
  });

  it('a full group clears; roles matter', () => {
    const full = group(['tank', 'healer', 'dps', 'dps', 'dps']);
    const runs = [1, 2, 3, 4, 5].map(seed => simulateRun(data, dungeon, full, seed));
    expect(runs.filter(r => r.cleared).length).toBeGreaterThanOrEqual(4);
    const r = runs.find(x => x.cleared)!;
    expect(r.kills.filter(k => k === 103)).toHaveLength(1);
    expect(r.xp.every(x => x > 0)).toBe(true);
    // Without a healer the same fights cost more lives (on real data they mostly wipe; see dev/dungeon-balance.ts).
    const deaths = (rs: RunResult[]) => rs.reduce((n, x) => n + x.events.filter(e => e.k === 'die' && !e.mob).length, 0);
    const noHealer = [1, 2, 3, 4, 5].map(seed => simulateRun(data, dungeon, group(['tank', 'dps', 'dps', 'dps', 'dps']), seed));
    expect(deaths(noHealer)).toBeGreaterThan(deaths(runs));
  });

  it('need before greed: the sword goes to the class that can use it, never to a hireling', () => {
    const g = group(['tank', 'healer', 'dps', 'dps', 'dps']);
    g[3] = { ...g[3], hireling: true, accountId: null };
    const r = [1, 2, 3, 4, 5, 6].map(seed => simulateRun(data, dungeon, g, seed)).find(x => x.cleared)!;
    const sword = r.loot.find(l => l.item === 12)!;
    expect(sword.winner).toBe(0); // the fighter (swords); mages can't use them
    expect(sword.rolls.find(x => x.member === 0)!.need).toBe(true);
    expect(sword.rolls.some(x => x.member === 3)).toBe(false);
    expect(canUse(data, g[1], data.items[12])).toBe(false);
  });

  it('fire resistance softens fire abilities', () => {
    const g = group(['tank', 'healer', 'dps', 'dps', 'dps']);
    const taken = (snaps: Snapshot[]) => simulateRun(data, dungeon, snaps, 3).events
      .filter(e => e.k === 'hit' && e.mob && e.spell === 999).reduce((a, e) => a + (e as { amt: number }).amt, 0);
    const resisted = g.map(sn => ({ ...sn, resist: [0, 0, 60, 0, 0, 0, 0] }));
    expect(taken(resisted)).toBeLessThan(taken(g));
  });
});

describe('raids', () => {
  const data = fixture();
  const d = data.dungeons[1];
  it('reset every three days at a fixed time, so a lockout never lasts longer than that', () => {
    const raid = { ...d, raid: true, resetDays: 3 };
    const now = 1_700_000_000_000;
    const r = nextReset(raid, now);
    expect(r).toBeGreaterThan(now);
    expect(r - now).toBeLessThanOrEqual(3 * 86_400_000);
    expect(nextReset(raid, r)).toBe(r + 3 * 86_400_000);
    expect(nextReset(raid, r - 1)).toBe(r);
  });
  it('list boss loot to target, best first; raids only rares and epics', () => {
    expect(dungeonLoot(data, d).get(103)).toEqual([12]); // the quality 1 bracers are left out
    expect(dungeonLoot(data, { ...d, id: 77, raid: true }).get(103)).toEqual([]);
  });
  it('bring raid buffs to groups of ten or more, and size the roles to the raid', () => {
    const snap = { maxHp: 1000, dps: 100, armor: 0, resist: [0, 0, 0, 0, 0, 0, 0], maxMana: 1000, heals: [] } as unknown as Snapshot;
    expect(withRaidBuffs(Array(5).fill(snap))[0]).toBe(snap);
    const buffed = withRaidBuffs(Array(10).fill(snap))[0];
    expect(buffed.dps).toBeGreaterThan(100);
    expect(buffed.maxHp).toBeGreaterThan(1000);
    expect(groupRoles(40)).toEqual({ tanks: 4, healers: 10 });
    expect(groupRoles(20)).toEqual({ tanks: 2, healers: 5 });
  });
});

describe('hunters and warlocks', () => {
  const d = fixture();
  d.classStats[3] = d.classStats[1];
  d.classStats[9] = d.classStats[8];
  d.levelStats[1][3] = d.levelStats[1][1];
  d.levelStats[1][9] = d.levelStats[1][8];
  const base = d.items[1];
  d.items[30] = { ...base, id: 30, name: 'Test Bow', class: 2, subclass: 2, invType: 15, stack: 1, dmgMin: 5, dmgMax: 9, delayMs: 2800 };
  d.items[31] = { ...base, id: 31, name: 'Test Arrow', class: 6, subclass: 2, invType: 24, stack: 200, dmgMin: 1, dmgMax: 2 };
  const as = (cls: number, level: number) => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 9, now: T0 });
    s.char.cls = cls;
    s.char.level = level;
    s.char.hp = playerStats(s, d).maxHp;
    s.inventory[5] = 200;
    return s;
  };
  it('hunters shoot with a ranged weapon and ammo (one arrow per shot), and melee without ammo', () => {
    const s = as(3, 5);
    s.equipment.ranged = 30;
    expect(rangedStats(s, d, 20)).toBeNull(); // no arrows yet
    s.inventory[31] = 100;
    expect(rangedStats(s, d, 20)!.dmgMin).toBeGreaterThan(5);
    const events: SimEvent[] = [];
    startAction(s, d, { kind: 'fight', creature: 100 });
    advance(s, d, T0 + 10 * 60_000, e => events.push(e));
    const shots = events.filter(e => e.type === 'swing' && e.who === 'player' && e.ranged).length;
    expect(shots).toBeGreaterThan(0);
    expect(100 - (s.inventory[31] ?? 0)).toBe(shots); // opening shots only: no pet below level 10
    expect(events.some(e => e.type === 'swing' && e.who === 'player' && !e.ranged)).toBe(true);
  });
  it('a tamed beast holds the mob, so the hunter keeps shooting', () => {
    const s = as(3, 9);
    expect(applyCommand(s, d, { name: 'tame', creature: 100 })).toEqual({ ok: false, error: 'You learn Tame Beast at level 10.' });
    s.char.level = 10;
    s.char.hp = playerStats(s, d).maxHp;
    expect(applyCommand(s, d, { name: 'tame', creature: 101 }).ok).toBe(false); // an elite
    expect(applyCommand(s, d, { name: 'tame', creature: 100 }).ok).toBe(true);
    expect(activePet(s)?.name).toBe('Test Boar');
    s.equipment.ranged = 30;
    s.inventory[31] = 200;
    const events: SimEvent[] = [];
    startAction(s, d, { kind: 'fight', creature: 100 });
    advance(s, d, T0 + 10 * 60_000, e => events.push(e));
    const mobHits = events.filter(e => e.type === 'swing' && e.who === 'mob');
    expect(mobHits.filter(e => e.type === 'swing' && e.target === 'pet').length).toBeGreaterThan(mobHits.length / 2);
    expect(events.filter(e => e.type === 'swing' && e.who === 'pet' && e.dmg > 0).length).toBeGreaterThan(0);
    const player = events.filter(e => e.type === 'swing' && e.who === 'player' && !e.spell);
    expect(player.filter(e => e.type === 'swing' && e.ranged).length).toBeGreaterThan(player.length * 0.8);
  });
  it('warlocks summon the Imp from level 1 and the Voidwalker (which tanks) from 10', () => {
    const s = as(9, 5);
    expect(activePet(s)?.kind).toBe('imp');
    expect(applyCommand(s, d, { name: 'demon', kind: 'voidwalker' }).ok).toBe(false);
    s.char.level = 10;
    expect(activePet(s)?.kind).toBe('voidwalker');
    const events: SimEvent[] = [];
    startAction(s, d, { kind: 'fight', creature: 100 });
    advance(s, d, T0 + 5 * 60_000, e => events.push(e));
    expect(events.some(e => e.type === 'swing' && e.target === 'pet')).toBe(true);
    expect(applyCommand(s, d, { name: 'demon', kind: 'imp' }).ok).toBe(true);
    expect(activePet(s)?.kind).toBe('imp');
  });
});

describe('bags', () => {
  const d = fixture();
  d.items[40] = { ...d.items[1], id: 40, name: 'Test Pouch', class: 1, invType: 18, stack: 1, bagSlots: 6 };
  d.items[41] = { ...d.items[1], id: 41, name: 'Test Quiver', class: 11, invType: 18, stack: 1, bagSlots: 4, bagFamily: 1 };
  d.items[42] = { ...d.items[1], id: 42, name: 'Test Arrow', class: 6, subclass: 2, stack: 200, bagFamily: 1 };
  const fill = (s: GameState, n: number) => { for (let i = 0; i < n; i++) s.inventory[1000 + i] = 1; for (let i = 0; i < n; i++) d.items[1000 + i] ??= { ...d.items[23], id: 1000 + i }; };
  it('a backpack holds 16 stacks; bags add slots; special bags hold only their family', () => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 1, now: T0 });
    s.inventory = {};
    fill(s, 16);
    expect(bagSpace(s, d)).toMatchObject({ total: 16, used: 16 });
    expect(roomFor(s, d, 1)).toBe(0);
    s.gold = 1000;
    expect(buy(s, d, 10, 1)).toEqual({ ok: false, error: 'Your bags are full.' });
    delete s.inventory[1015];
    s.inventory[40] = 1;
    expect(equipBag(s, d, 40).ok).toBe(true);
    expect(bagSpace(s, d)).toMatchObject({ total: 22, used: 15 });
    s.inventory[41] = 1;
    expect(equipBag(s, d, 41).ok).toBe(true);
    s.inventory[42] = 800; // four stacks of arrows: all in the quiver
    expect(bagSpace(s, d).used).toBe(15);
    expect(roomFor(s, d, 42)).toBe(7 * 200); // the quiver is full: arrows go in the 7 free general slots
    expect(applyCommand(s, d, { name: 'unequipBag', slot: 1 }).ok).toBe(true); // the arrows (and the quiver) move to general slots
    expect(bagSpace(s, d)).toMatchObject({ total: 22, used: 20 });
    s.inventory[2000] = 1; d.items[2000] = { ...d.items[23], id: 2000 }; s.inventory[2001] = 1; d.items[2001] = { ...d.items[23], id: 2001 };
    s.inventory[2002] = 1; d.items[2002] = { ...d.items[23], id: 2002 };
    expect(applyCommand(s, d, { name: 'unequipBag', slot: 0 }).ok).toBe(false); // 23 stacks wouldn't fit in 16
  });
  it('a personal bank takes deposits, and catches what the bags cannot hold when auto-deposit is on', () => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 1, now: T0 });
    s.inventory = { 3: 50 };
    expect(applyCommand(s, d, { name: 'bankDeposit', item: 3, count: 30 }).ok).toBe(true);
    expect(s.inventory[3]).toBe(20);
    expect(s.bank![3]).toBe(30);
    expect(applyCommand(s, d, { name: 'bankWithdraw', item: 3, count: 31 }).ok).toBe(false);
    expect(applyCommand(s, d, { name: 'bankWithdraw', item: 3, count: 10 }).ok).toBe(true);
    fill(s, 16);
    delete s.inventory[3];
    s.settings.autoDeposit = true;
    expect(giveItem(s, d, 1, 7)).toBe(7);
    expect(s.bank![1]).toBe(7);
    s.settings.autoDeposit = false;
    expect(giveItem(s, d, 1, 7)).toBe(0);
    expect(applyCommand(s, d, { name: 'bankDepositAll' }).ok).toBe(true);
    expect(Object.keys(s.inventory)).toHaveLength(0);
  });
  it('characters from before bag limits get four bags', () => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 1, now: T0 });
    delete (s as Partial<GameState>).bags;
    expect(migrateState(s, d).bags).toEqual([40, 40, 40, 40]);
  });
});

describe('commands from the network', () => {
  it('accept selling a whole large stack at once', () => {
    expect(parseCommand({ name: 'sell', item: 3, count: 1450 })).toEqual({ name: 'sell', item: 3, count: 1450 });
    expect(parseCommand({ name: 'sell', item: 3, count: 0 })).toBeNull();
  });
});

describe('poisons, totems and wands', () => {
  const d = fixture();
  for (const c of [4, 5, 7]) { d.classStats[c] = d.classStats[c === 5 ? 8 : 1]; d.levelStats[1][c] = d.levelStats[1][1]; }
  d.spells[9101] = { ...d.spells[901], id: 9101, chain: 9101, name: 'Instant Poison', nextSwing: false, spellLevel: 20, effects: [{ k: 'conjure', item: 1, count: 1, perLevel: 0 }] };
  d.items[50] = { ...d.items[1], id: 50, name: 'Test Wand', class: 2, subclass: 19, invType: 26, stack: 1, dmgMin: 20, dmgMax: 30, delayMs: 1500 };
  const as = (cls: number, level: number) => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 5, now: T0 });
    s.char.cls = cls; s.char.level = level; s.char.hp = playerStats(s, d).maxHp; s.inventory[5] = 200;
    return s;
  };
  const fightEvents = (s: GameState, ms = 10 * 60_000) => {
    const events: SimEvent[] = [];
    startAction(s, d, { kind: 'fight', creature: 100 });
    advance(s, d, T0 + ms, e => events.push(e));
    return events;
  };
  it('rogues who know Instant Poison poison their weapon hits', () => {
    const s = as(4, 20);
    s.spells = [9101];
    const ev = fightEvents(s);
    expect(ev.filter(e => e.type === 'swing' && e.spell === POISON_INSTANT && e.dmg >= 19 && e.dmg <= 25).length).toBeGreaterThan(3);
    const plain = as(4, 20);
    expect(fightEvents(plain).some(e => e.type === 'swing' && e.spell === POISON_INSTANT)).toBe(false);
  });
  it('shamans drop a Searing Totem and a Healing Stream, and Strength of Earth adds Strength', () => {
    const s = as(7, 20);
    const str0 = playerStats(as(1, 20), d).str;
    expect(playerStats(s, d).str).toBe(str0 + 10);
    const ev = fightEvents(s);
    expect(ev.some(e => e.type === 'swing' && e.spell === 3599)).toBe(true);
    expect(ev.some(e => e.type === 'heal' && e.spell === 5394)).toBe(true);
  });
  it('casters shoot their wand instead of meleeing', () => {
    const s = as(5, 10);
    s.equipment.ranged = 50;
    const ev = fightEvents(s);
    const swings = ev.filter(e => e.type === 'swing' && e.who === 'player' && !e.spell);
    expect(swings.length).toBeGreaterThan(5);
    expect(swings.every(e => e.type === 'swing' && e.ranged)).toBe(true);
  });
});

describe('pet happiness and abilities', () => {
  const d = fixture();
  d.classStats[3] = d.classStats[1]; d.classStats[9] = d.classStats[8];
  d.levelStats[1][3] = d.levelStats[1][1]; d.levelStats[1][9] = d.levelStats[1][8];
  d.petFamilies = { 5: { name: 'Boar', diet: 1 } }; // meat only
  d.creatures[100] = { ...d.creatures[100], family: 5 };
  d.items[5] = { ...d.items[5], foodType: 1 };       // Test Jerky is meat
  d.items[3] = { ...d.items[3], foodType: 2 };       // Raw Testfish is fish
  const hunter = () => {
    const s = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 3, now: T0 });
    s.char.cls = 3; s.char.level = 10; s.char.hp = playerStats(s, d).maxHp;
    expect(applyCommand(s, d, { name: 'tame', creature: 100 }).ok).toBe(true);
    return s;
  };
  it('a beast loses happiness as it fights and eats its diet from your bags', () => {
    const fed = hunter(), hungry = hunter();
    fed.inventory = { 5: 50, 3: 50 };
    hungry.inventory = { 3: 50 }; // fish only: a boar won't eat it
    for (const s of [fed, hungry]) { startAction(s, d, { kind: 'fight', creature: 100 }); advance(s, d, T0 + 2 * 3_600_000); }
    expect(hungry.pet!.happiness!).toBeLessThan(UNHAPPY);
    expect(hungry.inventory[3]).toBeGreaterThan(40); // (only eaten by the hunter, if at all)
    expect(fed.pet!.happiness!).toBeGreaterThanOrEqual(UNHAPPY);
    expect(fed.inventory[5] ?? 0).toBeLessThan(50);
  });
  it('an unhappy beast deals less damage; the Imp adds Stamina', () => {
    const s = hunter();
    s.pet!.happiness = 900;
    const happy = petStats(s, d, s.pet!).dmgMax;
    s.pet!.happiness = 100;
    expect(petStats(s, d, s.pet!).dmgMax).toBeLessThan(happy);
    const w = newGame(d, { name: 'Tester', race: 1, cls: 1, seed: 3, now: T0 });
    w.char.cls = 9; w.char.level = 14;
    expect(applyCommand(w, d, { name: 'demon', kind: 'imp' }).ok).toBe(true);
    const sta = playerStats(w, d).sta;
    w.char.cls = 1;
    expect(sta - playerStats(w, d).sta).toBe(9);
  });
});

describe('boss phases and attunements', () => {
  it('a boss phase brings in adds when the boss drops below its health mark', () => {
    const d = fixture();
    const dg = { ...d.dungeons[1], encounters: [{ boss: 103, mobs: [[103, 1]] as [number, number][], phases: [{ name: 'The boars come', hpPct: 50, adds: [[100, 2]] as [number, number][] }] }] };
    d.dungeons[1] = dg;
    const char = (cls: number) => {
      const s = newGame(d, { name: 'X', race: 1, cls, seed: 3, now: T0 });
      s.char.level = 12;
      s.spells = (d.classSpells[cls] ?? []).map(o => o.spell);
      s.combatSkills = { 95: 60, 162: 60, 43: 60 };
      return s;
    };
    const snaps = (['tank', 'healer', 'dps', 'dps', 'dps'] as Role[]).map((r, i) => snapshotOf(char(r === 'tank' ? 1 : 8), d, 100 + i, r, 12));
    const r = simulateRun(d, dg, snaps, 4);
    const adds = r.events.filter(e => e.k === 'adds');
    expect(adds.length).toBeGreaterThan(0);
    expect(adds[0].k === 'adds' && adds[0].mobs.length).toBe(2);
    if (r.cleared) expect(r.kills.filter(k => k === 100).length).toBeGreaterThanOrEqual(2);
  });
  it('raids need their attunement: a cleared dungeon, a quest, or a reputation', () => {
    const d = fixture();
    const raid = { ...d.dungeons[1], id: 2, raid: true, attune: { dungeon: 1, text: 'clear Test Hold once' } };
    const s = newGame(d, { name: 'X', race: 1, cls: 1, seed: 3, now: T0 });
    expect(attunementError(s, d, raid)).toBe('Requires attunement: clear Test Hold once.');
    s.cleared = [1];
    expect(attunementError(s, d, raid)).toBeNull();
  });
});
