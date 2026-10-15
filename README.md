# idlecwaft

A Melvor-style multiplayer guild idle game set in vanilla WoW, built from the data and assets of
**your own** WoW 1.12.1 (build 5875) client. See [DESIGN.md](DESIGN.md) for the systems.

## No Blizzard data in this repo

This repo holds only code. Game assets are read **at runtime from your local client**, or from a
local cache converted from it (`cache/`, gitignored). Every player runs the converter against their
own client. Nothing in this repo downloads, bundles or uploads game data.

## Setup

Requires Node 20+.

```bash
npm install
```

Copy `idle.config.example.json` to `idle.config.json` and set `clientPath` to your WoW 1.12.1 folder
(the one containing `WoW.exe` and `Data/`).

## Game data (VMaNGOS)

The client doesn't contain creature stats, spawns, loot or vendors. They come from the
[VMaNGOS](https://github.com/vmangos/core) world database (GPL-2.0). Download the SQLite release
(`db-sqlite-*.zip` from the `db_latest` release) and extract it so that this file exists:

```
data/vmangos/db/sqlite-dump/mangos.sqlite
```

`data/vmangos/` is gitignored.

## Build the local cache

```bash
npm run assets -- import
```

This builds Elwynn Forest's game data, icons, UI art, fonts, scenery, character and creature models
into `cache/` (about 95 MB, a couple of minutes).

## Host the guild server

The server owns every character and the guild. It needs `cache/data/game.json` (built by `import`
above) and stores accounts, characters and the guild in `data/server/idlecwaft.sqlite` (gitignored).

```bash
npm run server
```

It listens on port 7420 on all interfaces so friends on your VPN can reach it. Windows may ask to
allow Node through the firewall: allow it on private networks. Optional `server.config.json`
(gitignored) in the repo root: `{ "port": 7420, "guildName": "Idle Hands" }`.

With Tailscale, your server address for friends is `http://<your tailscale IP>:7420`
(see `tailscale ip -4`).

## Play

```bash
npm run game
```

Open http://localhost:5174, enter the guild server address (`http://localhost:7420` on the host
machine), and log in or create an account. Every new account joins the guild.

## Playing with friends

Each friend needs their own WoW 1.12.1 client and your VPN (e.g. Tailscale). They do **not** need
VMaNGOS: the server sends the game's data, and the art is converted from their own client.

### The launcher (recommended)

Friends download [`release/IdlecraftLauncher.exe`](release/IdlecraftLauncher.exe) from this repository
(Windows, ~68 MB, no Node needed — it's built in). It contains only this project's code and the Node
runtime: no WoW art or data. After code changes, rebuild it with `npm run build:launcher` (this also
refreshes `release/`) and commit the new exe.

A friend puts it in its own folder and double-clicks it:

1. First run: it asks for their WoW 1.12.1 folder and your server address (a bare `100.x.y.z` is fine),
   and remembers both in `idlecraft-launcher.json` next to the exe. Run with `--setup` to change them.
2. It converts the art the guild's world needs from their client into `idlecraft-cache/` next to the
   exe (about a minute the first time; again only when you add zones).
3. It opens the game in their browser at `http://localhost:7431` with your server filled in. They keep
   the launcher window open while playing.

Windows SmartScreen will say "unknown publisher" (the exe isn't code-signed): **More info → Run anyway**.

### From source (any OS)

Friends with Node 20+ and a copy of this repo can instead:

1. `npm install`
2. Copy `idle.config.example.json` to `idle.config.json` and set `clientPath` to their client.
3. Convert the art (about 95 MB, under a minute):

   ```bash
   npm run assets -- art --server http://100.x.y.z:7420
   ```

4. `npm run game`, open http://localhost:5174, enter `http://100.x.y.z:7420`, create an account.

Re-run step 3 whenever the host adds zones. (`npm run launcher` runs the launcher from source too,
after `npm run build -w @idle/game`.)

## Asset converter commands

```bash
npm run assets -- recon
```

```bash
npm run assets -- find-creature murloc
```

```bash
npm run assets -- creature 31 188 346
```

Output goes to `cache/creatures/<displayId>.glb` plus `cache/creatures/index.json`.
`--client <path>` and `--cache <dir>` override the config file.

## Model viewer (Phase 1 test page)

```bash
npm run viewer
```

Opens on http://localhost:5173 and lists every creature in the cache, with buttons for each animation.

## Tests

```bash
npm test
```

Format tests use synthetic data. Client integration tests run only when `idle.config.json` exists.
