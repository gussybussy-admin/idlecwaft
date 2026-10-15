// World of Idlecraft launcher.
//  1. First run: asks for the player's WoW 1.12.1 folder and the guild server address (remembered).
//  2. Converts the art the server's world needs, from the player's OWN client, into a local cache —
//     only when the server's world changed since last time.
//  3. Serves the game client + that cache on http://localhost and opens the browser.
//  Before that it updates itself when the guild server offers a newer launcher build.
// Nothing Blizzard-made is bundled in the launcher or downloaded; the cache is built on this machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { GameData } from '@idle/sim';
import { Client } from '../../../packages/assets/src/client.js';
import { convertArt } from '../../../packages/assets/src/convert/art.js';
import { LazyArt } from '../../../packages/assets/src/convert/lazy.js';
import { CLIENT_FILES } from './client-files.js';

// When packaged, process.execPath is the launcher .exe; from source it's node itself.
const packaged = !/^node(\.exe)?$/i.test(path.basename(process.execPath));
const home = packaged ? path.dirname(process.execPath) : path.resolve('launcher-data');
const cfgFile = path.join(home, 'idlecraft-launcher.json');
const cacheDir = path.join(home, 'idlecraft-cache');
const versionFile = path.join(cacheDir, '.world-version');
const PORTS = [7431, 7432, 7433, 7434, 7435];

interface Config { clientPath: string; server: string }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const say = (s = '') => console.log(s);

// Lines are queued as they arrive, so answers typed (or piped) before a question is asked aren't lost.
const lines: string[] = [];
let waiting: ((l: string | null) => void) | null = null;
let inputClosed = false;
rl.on('line', l => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { inputClosed = true; waiting?.(null); waiting = null; });
async function ask(q: string): Promise<string> {
  process.stdout.write(q);
  const l = lines.length ? lines.shift()! : inputClosed ? null : await new Promise<string | null>(r => { waiting = r; });
  if (l === null) { say('\nNo more input; exiting.'); process.exit(1); }
  if (!process.stdin.isTTY) say(l);
  return l.replace(/^﻿/, ''); // PowerShell pipes add a byte-order mark
}

function findDataDir(input: string): string | null {
  let p = input.trim().replace(/^["']|["']$/g, '');
  if (/\.exe$/i.test(p)) p = path.dirname(p);
  if (path.basename(p).toLowerCase() === 'data') p = path.dirname(p);
  const data = path.join(p, 'Data');
  try {
    if (fs.readdirSync(data).some(f => /\.mpq$/i.test(f))) return p;
  } catch { /* not a folder */ }
  return null;
}

function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  if (!/:\d+$/.test(s.replace(/^https?:\/\//i, ''))) s += ':7420';
  return s;
}

async function health(server: string): Promise<{ dataVersion: string } | null> {
  try {
    const r = await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() as { dataVersion: string } : null;
  } catch { return null; }
}

async function setup(prev?: Partial<Config>): Promise<Config> {
  say('First-time setup. (Run with --setup to change these later.)');
  let clientPath = prev?.clientPath && findDataDir(prev.clientPath) ? prev.clientPath : '';
  while (!clientPath) {
    const a = await ask('Path to your World of Warcraft 1.12.1 folder (the one with WoW.exe and Data): ');
    const found = findDataDir(a);
    if (found) clientPath = found; else say('  No Data folder with .MPQ files there. Try again (you can drag the folder into this window).');
  }
  let server = '';
  while (!server) {
    const a = await ask(`Guild server address from your host${prev?.server ? ` [${prev.server}]` : ''} (e.g. 100.101.102.103): `);
    const s = normalizeServer(a || prev?.server || '');
    if (await health(s)) server = s;
    else say(`  Can't reach ${s}. Is your VPN (e.g. Tailscale) connected, and is the host's server running?`);
  }
  const cfg = { clientPath, server };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return cfg;
}

async function ensureArt(cfg: Config, dataVersion: string): Promise<void> {
  const have = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (have === dataVersion && fs.existsSync(path.join(cacheDir, 'character/index.json'))) {
    say('Art is up to date.');
    return;
  }
  say(have ? 'The guild world changed — updating your art…' : 'Converting art from your WoW client (first time takes about a minute)…');
  const res = await fetch(`${cfg.server}/api/gamedata`);
  if (!res.ok) throw new Error(`The server answered ${res.status} for its world data.`);
  const data = await res.json() as GameData;
  const client = new Client(cfg.clientPath);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    convertArt(client, data, cacheDir, s => say(`  ${s}`));
  } finally {
    client.close();
  }
  fs.writeFileSync(versionFile, dataVersion);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};

/** The client build, from the embedded copy (packaged) or apps/game/dist (from source). */
function clientFile(rel: string): Buffer | null {
  if (CLIENT_FILES) return CLIENT_FILES[rel] !== undefined ? Buffer.from(CLIENT_FILES[rel], 'base64') : null;
  const file = path.resolve('apps/game/dist', rel);
  return file.startsWith(path.resolve('apps/game/dist')) && fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}

function serve(art: LazyArt): Promise<number> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.includes('..')) { res.writeHead(400); res.end(); return; }
    const type = TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
    // Our client build first, then the player's cache (creature models and icons convert on first use).
    let body = clientFile(rel) ?? art.get(rel);
    if (!body && !path.extname(rel)) { body = clientFile('index.html'); rel = 'index.html'; }
    if (!body) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': rel === 'index.html' ? TYPES['.html'] : type, 'cache-control': rel === 'index.html' ? 'no-cache' : 'max-age=3600' });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      if (i >= PORTS.length) return reject(new Error(`Ports ${PORTS.join(', ')} are all busy. Is the launcher already running?`));
      server.once('error', () => tryPort(i + 1));
      server.listen(PORTS[i], '127.0.0.1', () => resolve(PORTS[i]));
    };
    tryPort(0);
  });
}

/**
 * Keeps the launcher in step with the guild server: if the server offers a different build than this
 * exe, download it, check its SHA-256, swap it in (Windows lets a running exe be renamed, not
 * overwritten) and run the new one in this same window. Returns true if the new build took over.
 */
async function selfUpdate(server: string): Promise<boolean> {
  if (!packaged || process.argv.includes('--no-update')) return false;
  const exe = process.execPath, old = `${exe}.old`, part = `${exe}.download`;
  try { fs.rmSync(old, { force: true }); } catch { /* still locked by the previous run: next time */ }
  let info: { sha256: string; size: number };
  try {
    const r = await fetch(`${server}/api/launcher`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false; // the server has no launcher build to offer
    info = await r.json() as { sha256: string; size: number };
  } catch { return false; }
  const mine = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  if (mine === info.sha256) return false;
  say(`A new launcher version is available (${(info.size / 1024 / 1024).toFixed(0)} MB). Updating…`);
  try {
    const r = await fetch(`${server}/api/launcher/download`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(buf).digest('hex') !== info.sha256) throw new Error('the download was damaged');
    fs.writeFileSync(part, buf);
    fs.renameSync(exe, old);
    fs.renameSync(part, exe);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    if (!fs.existsSync(exe) && fs.existsSync(old)) fs.renameSync(old, exe);
    say(`Couldn't update (${(e as Error).message}); starting this version.`);
    return false;
  }
  say('Updated. Restarting…');
  say();
  rl.close();
  const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
  return true;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  spawn(cmd[0], [...cmd[1]], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref();
}

async function main(): Promise<void> {
  say('World of Idlecraft launcher');
  say('───────────────────────────');
  if (!clientFile('index.html')) throw new Error('The game client is missing. From source, run: npm run build -w @idle/game');
  let cfg: Config | null = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Config; } catch { /* first run */ }
  if (!cfg || process.argv.includes('--setup') || !findDataDir(cfg.clientPath)) cfg = await setup(cfg ?? undefined);

  let h = await health(cfg.server);
  while (!h) {
    say(`Can't reach the guild server at ${cfg.server}.`);
    const a = await ask('Press Enter to retry, or type a new address: ');
    if (a.trim()) { cfg = { ...cfg, server: normalizeServer(a) }; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); }
    h = await health(cfg.server);
  }
  say(`Guild server: ${cfg.server}`);
  if (await selfUpdate(cfg.server)) return; // the new build carries on in this window
  await ensureArt(cfg, h.dataVersion);

  const port = await serve(new LazyArt(new Client(cfg.clientPath), cacheDir));
  const url = `http://localhost:${port}/?server=${encodeURIComponent(cfg.server)}`;
  say();
  say(`Game running at ${url}`);
  say('Opening your browser… Keep this window open while you play; close it to quit.');
  say('(Your character keeps progressing on the guild server for up to 24 hours after you close the game.)');
  rl.close();
  if (!process.argv.includes('--no-browser')) openBrowser(url);
}

main().catch(async e => {
  say();
  say(`Error: ${(e as Error).message ?? e}`);
  await ask('Press Enter to close.');
  process.exit(1);
});
