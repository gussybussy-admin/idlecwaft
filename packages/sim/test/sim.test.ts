import { describe, expect, it } from 'vitest';
import {
  advance, buy, catchUp, equip, gatherColor, grayLevel, killXp, newGame, OFFLINE_CAP_MS, planTravel, playerStats,
  rollLoot, RUN_SPEED, seedRng, sell, startAction, stopAction, train, trainRiding, trainSpells, knownSpells,
  learnTalent, pointsSpent, modded, activeTalentEffects, resetTalents, resetCost,
  disenchant, unlearnProfession, acceptQuest, abandonQuest, completeQuest, questComplete, availableQuests, standing, repRank, migrateState, applyCommand, parseCommand,
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
    expect(startAction(s, data, { kind: 'fish' }).ok).toBe(true);
    advance(s, data, T0 + 3_600_000);
    expect((s.inventory[3] ?? 0) + (s.inventory[4] ?? 0)).toBeGreaterThan(50);
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
