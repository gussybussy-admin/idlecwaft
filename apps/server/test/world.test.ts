import { describe, expect, it } from 'vitest';
import { OFFLINE_CAP_MS } from '@idle/sim';
import { fixture } from '../../../packages/sim/test/fixture.js';
import { openDb } from '../src/db.js';
import { register } from '../src/auth.js';
import { World } from '../src/world.js';

const data = fixture();
const H = 3_600_000;

function setup(d = data) {
  let now = 1_700_000_000_000;
  const clock = { get: () => now, set: (t: number) => { now = t; }, add: (ms: number) => { now += ms; } };
  const db = openDb(':memory:', 'Idle Hands');
  const world = new World(db, d, clock.get);
  const account = (name: string) => {
    const r = register(db, name, 'password1', now);
    if (!r.ok) throw new Error(r.error);
    expect(world.createCharacter(r.accountId, name.slice(0, 12).replace(/\d/g, ''), 1, 1).ok).toBe(true);
    return r.accountId;
  };
  return { db, world, clock, account };
}

describe('server-authoritative simulation', () => {
  it('keeps simulating an offline character for 24h after last seen, then pauses', () => {
    const { world, clock, account } = setup();
    const a = account('alice');
    world.connect(a);
    expect(world.command(a, { name: 'start', action: { kind: 'fight', creature: 100 } }).ok).toBe(true);
    const t0 = clock.get();
    world.disconnect(a);
    clock.add(30 * H);
    world.tick();
    expect(world.stateOf(a)!.now).toBe(t0 + OFFLINE_CAP_MS);
    const away = world.connect(a)!;
    expect(away.ms).toBe(OFFLINE_CAP_MS);
    expect(away.kills).toBeGreaterThan(100);
    expect(world.stateOf(a)!.now).toBe(clock.get()); // resumes from now; the 6h beyond the cap are skipped
  });

  it('advances online characters in real time and reports nothing for short absences', () => {
    const { world, clock, account } = setup();
    const a = account('bob');
    world.connect(a);
    world.command(a, { name: 'start', action: { kind: 'fight', creature: 100 } });
    clock.add(10 * 60_000);
    world.tick();
    expect(world.stateOf(a)!.now).toBe(clock.get());
    world.disconnect(a);
    clock.add(30_000);
    expect(world.connect(a)).toBeNull();
  });

  it('persists characters and reloads them', () => {
    const { db, world, clock, account } = setup();
    const a = account('carol');
    world.connect(a);
    world.command(a, { name: 'start', action: { kind: 'fight', creature: 100 } });
    clock.add(H);
    world.tick();
    world.save();
    const reloaded = new World(db, data, clock.get);
    expect(reloaded.stateOf(a)).toEqual(world.stateOf(a));
  });
});

describe('guild bank and requests', () => {
  it('deposits and withdraws items and gold with a log', () => {
    const { world, account } = setup();
    const a = account('dave');
    const s = world.stateOf(a)!;
    s.inventory[2] = 10; s.gold = 500;
    expect(world.deposit(a, 2, 4, undefined).ok).toBe(true);
    expect(world.deposit(a, undefined, undefined, 200).ok).toBe(true);
    expect(world.deposit(a, 2, 50, undefined)).toEqual({ ok: false, error: "You don't have that many." });
    let g = world.guildSnapshot();
    expect(g.bank).toEqual([{ item: 2, count: 4 }]);
    expect(g.gold).toBe(200);
    expect(world.withdraw(a, 2, 5, undefined).ok).toBe(false);
    expect(world.withdraw(a, 2, 4, undefined).ok).toBe(true);
    expect(world.withdraw(a, undefined, undefined, 50).ok).toBe(true);
    g = world.guildSnapshot();
    expect(g.bank).toEqual([]);
    expect(g.gold).toBe(150);
    expect(world.stateOf(a)!.inventory[2]).toBe(10);
    expect(world.stateOf(a)!.gold).toBe(350);
    expect(g.log.map(l => `${l.kind}:${l.item ?? 'gold'}:${l.count || l.gold}`)).toEqual(['withdraw:gold:50', 'withdraw:2:4', 'deposit:gold:200', 'deposit:2:4']);
  });

  it('lets another member fill a request directly', () => {
    const { world, account } = setup();
    const asker = account('erin'), giver = account('frank');
    expect(world.createRequest(asker, 2, 20, 'for smelting').ok).toBe(true);
    const req = world.guildSnapshot().requests[0];
    expect(world.fillRequest(asker, req.id, 5)).toEqual({ ok: false, error: "You can't fill your own request." });
    world.stateOf(giver)!.inventory[2] = 12;
    expect(world.fillRequest(giver, req.id, 12).ok).toBe(true);
    expect(world.stateOf(asker)!.inventory[2]).toBe(12);
    expect(world.stateOf(giver)!.inventory[2]).toBeUndefined();
    world.stateOf(giver)!.inventory[2] = 30;
    expect(world.fillRequest(giver, req.id, 30).ok).toBe(true); // only the remaining 8 move
    expect(world.stateOf(giver)!.inventory[2]).toBe(22);
    const r = world.guildSnapshot().requests.find(x => x.id === req.id)!;
    expect(r).toMatchObject({ filled: 20, open: false });
  });

  it('runs a crafting order: escrowed reagents and tip, claim, craft, deliver', () => {
    const { world, account, clock } = setup();
    const buyer = account('gina'), smith = account('hal');
    const b = world.stateOf(buyer)!, s = world.stateOf(smith)!;
    b.inventory[2] = 5; b.gold = 100;
    expect(world.createOrder(buyer, 310, 3, true, 40, 'sharpeners please').ok).toBe(true);
    expect(b.inventory[2]).toBe(2); // 3 ore held for the order
    expect(b.gold).toBe(60);
    const id = world.guildSnapshot().orders[0].id;
    expect(world.claimOrder(smith, id)).toEqual({ ok: false, error: "You don't know Rough Test Sharpener." });
    s.gold = 100;
    world.command(smith, { name: 'train', skill: 'blacksmithing' });
    s.inventory[5956] = 1;
    expect(world.claimOrder(smith, id).ok).toBe(true);
    expect(s.inventory[2]).toBe(3);
    expect(world.cancelOrder(buyer, id)).toEqual({ ok: false, error: 'A crafter is already working on it.' });
    expect(world.deliverOrder(smith, id).ok).toBe(false); // nothing crafted yet
    world.connect(smith);
    world.command(smith, { name: 'start', action: { kind: 'craft', recipe: 310 } });
    clock.add(60_000);
    world.tick();
    expect(world.deliverOrder(smith, id).ok).toBe(true);
    expect(world.stateOf(buyer)!.inventory[5]).toBe(3);
    expect(world.stateOf(smith)!.gold).toBe(100 - 10 + 40); // training cost 10c, tip 40c
    expect(world.guildSnapshot().orders[0]).toMatchObject({ open: false, delivered: true, crafterId: smith });
  });

  it('cancelling an unclaimed order returns the reagents and tip', () => {
    const { world, account } = setup();
    const buyer = account('ivy');
    const b = world.stateOf(buyer)!;
    b.inventory[2] = 2; b.gold = 50;
    expect(world.createOrder(buyer, 310, 2, true, 20, '').ok).toBe(true);
    expect(world.cancelOrder(buyer, world.guildSnapshot().orders[0].id).ok).toBe(true);
    expect(b.inventory[2]).toBe(2);
    expect(b.gold).toBe(50);
  });
});

describe('dungeons', () => {
  it('forms a group, fills it with hirelings, keeps members busy, then delivers rewards', () => {
    const { world, account, clock } = setup();
    const lead = account('jade'), friend = account('kim');
    for (const id of [lead, friend]) {
      const st = world.stateOf(id)!;
      st.char.level = 12;
      st.spells = (data.classSpells[st.char.cls] ?? []).map(o => o.spell);
    }
    expect(world.createGroup(lead, 1, 'healer')).toEqual({ ok: false, error: "Fighters can't heal." });
    expect(world.createGroup(lead, 1, 'tank').ok).toBe(true);
    const grp = world.guildSnapshot().groups[0];
    expect(world.joinGroup(friend, grp.id, 'dps').ok).toBe(true);
    expect(world.startGroup(friend, grp.id)).toEqual({ ok: false, error: 'Only the group leader can start the run.' });
    expect(world.startGroup(lead, grp.id, 42).ok).toBe(true);
    const running = world.guildSnapshot().groups[0];
    expect(running.status).toBe('running');
    expect(running.run!.members).toHaveLength(5);
    expect(running.run!.members.filter(m => m.hireling)).toHaveLength(3);
    expect(running.run!.members.some(m => m.role === 'healer' && m.hireling)).toBe(true);
    expect(world.stateOf(lead)!.action?.kind).toBe('dungeon');
    expect(world.command(lead, { name: 'stop' })).toEqual({ ok: false, error: "You're in a dungeon with your group." });
    const gold0 = world.stateOf(friend)!.gold; // (level 12 is the fixture's level cap, so no XP)
    clock.add(running.run!.ends - clock.get() + 1000);
    world.tick();
    expect(world.stateOf(lead)!.action).toBeNull();
    expect(world.stateOf(friend)!.gold).toBeGreaterThan(gold0);
    expect(world.stateOf(friend)!.log.some(l => l.text.startsWith('Test Hold:'))).toBe(true);
    const done = world.guildSnapshot().groups[0];
    expect(done.status).toBe('done');
    const replay = world.replay(done.run!.id)!;
    expect(replay.run.events.length).toBeGreaterThan(10);
    expect(replay.snapshots).toHaveLength(5);
  });
});

describe('chat and feed', () => {
  it('broadcasts chat with a rate limit and announces joins and rank-ups', () => {
    const { world, account } = setup();
    const chats: string[] = [], feed: string[] = [];
    world.on({ chat: m => chats.push(`${m.who}: ${m.text}`), feed: f => feed.push(f.text) });
    const a = account('gina');
    for (let i = 0; i < 7; i++) world.chat(a, `hi ${i}`);
    expect(chats).toHaveLength(5);
    world.stateOf(a)!.gold = 100;
    world.command(a, { name: 'train', skill: 'mining' });
    expect(feed).toEqual(['Gina joined the guild.', 'Gina is now an Apprentice Mining.']);
  });

  it('announces elite kills once per window and level milestones every 10 levels', () => {
    const weakOgre = fixture();
    weakOgre.creatures[101].stats = [{ hp: 40, dmgMin: 1, dmgMax: 2, armor: 0 }];
    const { world, clock, account } = setup(weakOgre);
    const feed: string[] = [];
    world.on({ feed: f => feed.push(f.text) });
    const a = account('hank');
    world.stateOf(a)!.char.level = 12;
    world.connect(a);
    world.command(a, { name: 'start', action: { kind: 'fight', creature: 101 } });
    clock.add(2 * H);
    world.tick();
    const kills = feed.filter(f => f.includes('Test Ogre'));
    expect(kills.length).toBeGreaterThan(0);
    expect(kills.length).toBeLessThanOrEqual(5); // throttled: at most one per 30 minutes
    expect(feed.some(f => /reached level/.test(f))).toBe(false); // the fixture caps at 12, no milestone
  });
});
