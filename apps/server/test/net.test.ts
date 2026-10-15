// End-to-end: real HTTP + WebSocket server on a random port, two players.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@idle/sim';
import { fixture } from '../../../packages/sim/test/fixture.js';
import { openDb } from '../src/db.js';
import { World } from '../src/world.js';
import { createServer } from '../src/net.js';

const data = fixture();
let base = '', server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const db = openDb(':memory:', 'Idle Hands');
  const world = new World(db, data);
  server = createServer({ db, world, gameDataJson: JSON.stringify(data) });
  await new Promise<void>(r => server.httpServer.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown) => fetch(`http://${base}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

/** A scripted client: collects messages and lets the test wait for one. */
async function client(token: string) {
  const ws = new WebSocket(`ws://${base}/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: [(m: ServerMessage) => boolean, (m: ServerMessage) => void][] = [];
  ws.on('message', raw => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    inbox.push(m);
    for (const w of [...waiters]) if (w[0](m)) { waiters.splice(waiters.indexOf(w), 1); w[1](m); }
  });
  await new Promise(r => ws.once('open', r));
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  const wait = <T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) =>
    new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const seen = inbox.find(m => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (seen) { inbox.splice(inbox.indexOf(seen), 1); return resolve(seen as Extract<ServerMessage, { t: T }>); }
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 3000);
      waiters.push([m => m.t === t && pred(m as Extract<ServerMessage, { t: T }>), m => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); }]);
    });
  send({ t: 'auth', token });
  return { ws, send, wait, close: () => ws.close() };
}

describe('game server over the network', () => {
  it('registers, creates characters, syncs state, chats and trades', async () => {
    const health = await fetch(`http://${base}/api/health`).then(r => r.json());
    expect(health.ok).toBe(true);
    expect((await post('/api/register', { username: 'al', password: 'secret1' })).ok).toBe(false); // too short
    const a = await post('/api/register', { username: 'alice', password: 'secret1' });
    const b = await post('/api/register', { username: 'bobby', password: 'secret2' });
    expect(a.ok && b.ok).toBe(true);
    expect((await post('/api/login', { username: 'alice', password: 'wrong' })).ok).toBe(false);
    expect((await post('/api/login', { username: 'ALICE', password: 'secret1' })).ok).toBe(true);

    const gd = await fetch(`http://${base}/api/gamedata`);
    expect(gd.status).toBe(200);
    expect(await fetch(`http://${base}/api/gamedata`, { headers: { 'if-none-match': gd.headers.get('etag')! } }).then(r => r.status)).toBe(304);

    const ca = await client(a.token);
    await ca.wait('needCharacter');
    ca.send({ t: 'create', name: 'alice', race: 1, cls: 1 });
    const hello = await ca.wait('hello');
    expect(hello.guild.name).toBe('Idle Hands');
    const st = await ca.wait('state');
    expect(st.state.char.name).toBe('Alice');

    const cb = await client(b.token);
    cb.send({ t: 'create', name: 'bobby', race: 2, cls: 1 }); // a Horde player in the same guild
    await cb.wait('hello');

    // a server-validated command
    ca.send({ t: 'cmd', id: 1, cmd: { name: 'start', action: { kind: 'fight', creature: 100 } } });
    expect(await ca.wait('result', m => m.id === 1)).toMatchObject({ ok: true });
    const after = await ca.wait('state', m => m.state.action?.kind === 'fight');
    expect(after.state.action).toEqual({ kind: 'fight', creature: 100 });
    ca.send({ t: 'cmd', id: 2, cmd: { name: 'start', action: { kind: 'gather', node: 200 } } });
    expect(await ca.wait('result', m => m.id === 2)).toMatchObject({ ok: false, error: 'You need to train Mining first.' });
    ca.send({ t: 'cmd', id: 3, cmd: { name: 'hack', gold: 1e9 } as never });
    expect(await ca.wait('result', m => m.id === 3)).toMatchObject({ ok: false, error: 'Unknown command.' });

    // chat reaches the other player
    ca.send({ t: 'chat', text: 'hello guild' });
    expect((await cb.wait('chat')).msg).toMatchObject({ who: 'Alice', text: 'hello guild' });

    // guild bank: Bobby can't withdraw what isn't there
    cb.send({ t: 'bank', id: 7, op: 'withdraw', item: 2, count: 1 });
    expect(await cb.wait('result', m => m.id === 7)).toMatchObject({ ok: false });

    // roster shows both online
    const g = await cb.wait('guild', m => m.guild.roster.filter(r => r.online).length === 2);
    expect(g.guild.roster.map(r => r.name).sort()).toEqual(['Alice', 'Bobby']);
    expect(g.guild.feed.map(f => f.text)).toEqual(expect.arrayContaining(['Alice joined the guild.', 'Bobby joined the guild.']));

    ca.close(); cb.close();
  });

  it('rejects bad tokens', async () => {
    const c = await client('0'.repeat(64));
    expect((await c.wait('error')).error).toMatch(/log in/);
  });
});
