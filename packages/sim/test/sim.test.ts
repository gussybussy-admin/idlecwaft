import { describe, expect, it } from 'vitest';
import {
  advance, buy, catchUp, equip, gatherColor, grayLevel, killXp, newGame, OFFLINE_CAP_MS, playerStats,
  rollLoot, seedRng, sell, startAction, stopAction, train, type GameState, type SimEvent,
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
    for (let i = 0; i < 4000; i++) for (const [item] of rollLoot(data.zones[0].fishing!.loot, rng)) counts[item as 3 | 4]++;
    expect(counts[3] + counts[4]).toBe(4000); // a group always yields exactly one entry here
    expect(counts[3] / 4000).toBeGreaterThan(0.45);
    expect(counts[3] / 4000).toBeLessThan(0.55);
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
  it('a level 1 fighter farms level 1-2 boars and levels up', () => {
    const s = fresh();
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
