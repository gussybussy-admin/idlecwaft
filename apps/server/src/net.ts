// HTTP (register/login/game data) and WebSocket (game session) front-end for the World.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseCommand, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@idle/sim';
import type { DB } from './db.js';
import { login, logout, register, sessionAccount } from './auth.js';
import type { World } from './world.js';

/** Full state resync for each connected client, on top of resyncs after every change. */
const RESYNC_MS = 30_000;
const MAX_BODY = 16 * 1024;

export interface NetOptions {
  db: DB; world: World; gameDataJson: string; clock?: () => number;
  /** The current launcher build, offered to launchers so they update themselves (optional). */
  launcherFile?: string;
}

export function createServer({ db, world, gameDataJson, clock = Date.now, launcherFile }: NetOptions) {
  const dataVersion = crypto.createHash('sha1').update(gameDataJson).digest('hex').slice(0, 16);
  const gameDataGzip = zlib.gzipSync(gameDataJson, { level: 9 }); // ~9 MB of JSON compresses ~10x
  const sockets = new Map<WebSocket, { accountId: number; username: string } | null>();
  const watching = new Map<WebSocket, number | null>();

  const send = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const forAccount = (accountId: number, fn: (ws: WebSocket) => void) => {
    for (const [ws, a] of sockets) if (a?.accountId === accountId) fn(ws);
  };
  const sendState = (ws: WebSocket, accountId: number) => {
    const state = world.stateOf(accountId);
    if (state) send(ws, { t: 'state', serverTime: clock(), state });
  };

  // Guild snapshots are debounced: several changes in one moment become one broadcast.
  let guildTimer: NodeJS.Timeout | null = null;
  const off = world.on({
    state: accountId => forAccount(accountId, ws => sendState(ws, accountId)),
    guild: () => {
      if (guildTimer) return;
      guildTimer = setTimeout(() => {
        guildTimer = null;
        const g = world.guildSnapshot();
        for (const [ws, a] of sockets) if (a && world.hasCharacter(a.accountId)) send(ws, { t: 'guild', guild: g });
      }, 150);
    },
    chat: msg => { for (const [ws, a] of sockets) if (a) send(ws, { t: 'chat', msg }); },
    feed: item => { for (const [ws, a] of sockets) if (a) send(ws, { t: 'feed', item }); },
  });

  // The launcher on offer: hashed once per change of the file (the host rebuilds it after updates).
  let launcherInfo: { mtimeMs: number; size: number; sha256: string } | null = null;
  const launcher = () => {
    if (!launcherFile) return null;
    let st: fs.Stats;
    try { st = fs.statSync(launcherFile); } catch { return null; }
    if (launcherInfo?.mtimeMs !== st.mtimeMs || launcherInfo.size !== st.size) {
      launcherInfo = { mtimeMs: st.mtimeMs, size: st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(launcherFile)).digest('hex') };
    }
    return launcherInfo;
  };

  // ---------------------------------------------------------------- HTTP
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, protocol: PROTOCOL_VERSION, dataVersion });
    if (req.method === 'GET' && url.pathname === '/api/gamedata') {
      if (req.headers['if-none-match'] === dataVersion) { res.writeHead(304); res.end(); return; }
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
      res.writeHead(200, { 'content-type': 'application/json', etag: dataVersion, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      res.end(gzip ? gameDataGzip : gameDataJson);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/launcher') {
      const l = launcher();
      return l ? json(200, { ok: true, sha256: l.sha256, size: l.size }) : json(404, { ok: false, error: 'No launcher build on this server.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/launcher/download') {
      const l = launcher();
      if (!l) return json(404, { ok: false, error: 'No launcher build on this server.' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': l.size, 'x-sha256': l.sha256 });
      fs.createReadStream(launcherFile!).pipe(res);
      return;
    }
    if (req.method === 'POST' && ['/api/register', '/api/login', '/api/logout'].includes(url.pathname)) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
      req.on('end', () => {
        let b: { username?: unknown; password?: unknown; token?: unknown };
        try { b = JSON.parse(body || '{}'); } catch { return json(400, { ok: false, error: 'Bad JSON.' }); }
        if (url.pathname === '/api/logout') { if (typeof b.token === 'string') logout(db, b.token); return json(200, { ok: true }); }
        const fn = url.pathname === '/api/register' ? register : login;
        const r = fn(db, String(b.username ?? ''), String(b.password ?? ''), clock());
        json(r.ok ? 200 : 400, r.ok ? { ok: true, token: r.token, username: r.username } : r);
      });
      return;
    }
    json(404, { ok: false, error: 'Not found.' });
  });

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  const welcome = (ws: WebSocket, accountId: number, username: string) => {
    send(ws, { t: 'hello', serverTime: clock(), account: { id: accountId, username }, guild: world.guildSnapshot(), dataVersion });
    const away = world.connect(accountId);
    sendState(ws, accountId);
    if (away) send(ws, { t: 'away', summary: away });
  };

  wss.on('connection', ws => {
    sockets.set(ws, null);
    const authTimeout = setTimeout(() => { if (!sockets.get(ws)) ws.close(4001, 'auth timeout'); }, 10_000);
    const resync = setInterval(() => { const a = sockets.get(ws); if (a && world.hasCharacter(a.accountId)) sendState(ws, a.accountId); }, RESYNC_MS);

    ws.on('message', raw => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(raw)); } catch { return send(ws, { t: 'error', error: 'Bad message.' }); }
      const acct = sockets.get(ws);
      if (msg.t === 'ping') return send(ws, { t: 'pong', serverTime: clock() });
      if (!acct) {
        if (msg.t !== 'auth') return send(ws, { t: 'error', error: 'Not logged in.' });
        const a = sessionAccount(db, msg.token);
        if (!a) { send(ws, { t: 'error', error: 'Session expired. Please log in again.' }); ws.close(4001, 'bad token'); return; }
        clearTimeout(authTimeout);
        sockets.set(ws, { accountId: a.id, username: a.username });
        if (world.hasCharacter(a.id)) welcome(ws, a.id, a.username);
        else send(ws, { t: 'needCharacter' });
        return;
      }
      const id = 'id' in msg && typeof msg.id === 'number' ? msg.id : 0;
      const reply = (r: { ok: boolean; error?: string }) => send(ws, { t: 'result', id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
      switch (msg.t) {
        case 'create': {
          const r = world.createCharacter(acct.accountId, msg.name, msg.race, msg.cls, msg.look);
          if (!r.ok) return send(ws, { t: 'error', error: r.error });
          return welcome(ws, acct.accountId, acct.username);
        }
        case 'cmd': {
          const cmd = parseCommand(msg.cmd);
          return reply(cmd ? world.command(acct.accountId, cmd) : { ok: false, error: 'Unknown command.' });
        }
        case 'chat': { const r = world.chat(acct.accountId, msg.text); if (!r.ok) send(ws, { t: 'error', error: r.error }); return; }
        case 'bank':
          return reply(msg.op === 'deposit' ? world.deposit(acct.accountId, msg.item, msg.count, msg.gold)
            : msg.op === 'withdraw' ? world.withdraw(acct.accountId, msg.item, msg.count, msg.gold) : { ok: false, error: 'Bad op.' });
        case 'request':
          return reply(msg.op === 'create' ? world.createRequest(acct.accountId, msg.item, msg.count, msg.note)
            : msg.op === 'fill' ? world.fillRequest(acct.accountId, msg.request, msg.count)
            : msg.op === 'cancel' ? world.cancelRequest(acct.accountId, msg.request) : { ok: false, error: 'Bad op.' });
        case 'group':
          return reply(msg.op === 'create' ? world.createGroup(acct.accountId, msg.dungeon, msg.role, msg.targets)
            : msg.op === 'join' ? world.joinGroup(acct.accountId, msg.group, msg.role, msg.targets)
            : msg.op === 'targets' ? world.setTargets(acct.accountId, msg.group, msg.targets)
            : msg.op === 'leave' || msg.op === 'cancel' ? world.leaveGroup(acct.accountId, msg.group)
            : msg.op === 'start' ? world.startGroup(acct.accountId, msg.group) : { ok: false, error: 'Bad op.' });
        case 'watch': {
          const run = typeof msg.run === 'number' ? msg.run : null;
          world.watch(acct.accountId, run, watching.get(ws) ?? null);
          watching.set(ws, run);
          return;
        }
        case 'replay': {
          const r = world.replay(msg.run);
          if (!r) return reply({ ok: false, error: 'No such run.' });
          return send(ws, { t: 'replay', id: msg.id, run: r.run, snapshots: r.snapshots });
        }
        case 'order':
          return reply(msg.op === 'create' ? world.createOrder(acct.accountId, msg.recipe, msg.count, msg.provide, msg.tip, msg.note)
            : msg.op === 'claim' ? world.claimOrder(acct.accountId, msg.order)
            : msg.op === 'deliver' ? world.deliverOrder(acct.accountId, msg.order)
            : msg.op === 'cancel' ? world.cancelOrder(acct.accountId, msg.order) : { ok: false, error: 'Bad op.' });
        default: return send(ws, { t: 'error', error: 'Unknown message.' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(resync);
      const a = sockets.get(ws);
      sockets.delete(ws);
      if (a && watching.get(ws) != null) world.watch(a.accountId, null, watching.get(ws)!);
      watching.delete(ws);
      if (a && world.hasCharacter(a.accountId)) world.disconnect(a.accountId);
    });
  });

  return {
    httpServer,
    close: () => new Promise<void>(resolve => {
      off();
      if (guildTimer) clearTimeout(guildTimer);
      for (const ws of sockets.keys()) ws.terminate();
      wss.close();
      httpServer.close(() => resolve());
    }),
  };
}
