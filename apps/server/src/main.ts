// Starts the game server. Configuration: server.config.json (gitignored) or env vars.
//   PORT (7420), HOST (0.0.0.0 so VPN peers can connect), GUILD_NAME, DB_FILE, GAME_DATA
import fs from 'node:fs';
import path from 'node:path';
import type { GameData } from '@idle/sim';
import { openDb } from './db.js';
import { World } from './world.js';
import { createServer } from './net.js';

const root = path.resolve(import.meta.dirname, '../../..');
const cfgFile = path.join(root, 'server.config.json');
const cfg: Record<string, string | number> = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const opt = (k: string, env: string, d: string | number) => process.env[env] ?? cfg[k] ?? d;

const port = Number(opt('port', 'PORT', 7420));
const host = String(opt('host', 'HOST', '0.0.0.0'));
const guildName = String(opt('guildName', 'GUILD_NAME', 'Idle Hands'));
const dbFile = path.resolve(root, String(opt('dbFile', 'DB_FILE', 'data/server/idlecwaft.sqlite')));
const dataFile = path.resolve(root, String(opt('gameData', 'GAME_DATA', 'cache/data/game.json')));

if (!fs.existsSync(dataFile)) {
  console.error(`No game data at ${dataFile}. Build it first: npm run assets -- import`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const gameDataJson = fs.readFileSync(dataFile, 'utf8');
const data = JSON.parse(gameDataJson) as GameData;
const db = openDb(dbFile, guildName);
const world = new World(db, data);
const launcherFile = path.join(root, 'release', 'IdlecraftLauncher.exe');
const server = createServer({ db, world, gameDataJson, launcherFile });

const tick = setInterval(() => world.tick(), 1000);
const save = setInterval(() => world.save(), 10_000);

server.httpServer.listen(port, host, () => {
  console.log(`World of Idlecraft server: guild "${guildName}", listening on http://${host}:${port}`);
  if (fs.existsSync(launcherFile)) console.log(`  offering launcher updates from ${path.relative(root, launcherFile)}`);
  console.log(`  game data ${path.relative(root, dataFile)} (${data.zones.map(z => z.name).join(', ')}), db ${path.relative(root, dbFile)}`);
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  clearInterval(save);
  world.tick();
  await server.close();
  world.save();
  db.close();
  console.log('Saved. Bye.');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
