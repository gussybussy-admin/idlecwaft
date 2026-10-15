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

## Asset converter

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
