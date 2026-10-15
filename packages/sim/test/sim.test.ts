import { describe, expect, it } from 'vitest';
import {
  advance, buy, catchUp, equip, gatherColor, grayLevel, killXp, newGame, OFFLINE_CAP_MS, planTravel, playerStats,
  rollLoot, RUN_SPEED, seedRng, sell, startAction, stopAction, train, trainRiding, type GameState, type SimEvent,
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
    expect(startAction(s, data, { kind: 'cook', recipe: 300 }).ok).toBe(true);
    advance(s, data, T0 + 60_000);
    expect(s.inventory[1]).toBeUndefined();
    expect(s.inventory[6]).toBe(5);
    expect(s.action).toBeNull();
    expect(s.skills.cooking.level).toBeGreaterThan(1);
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
