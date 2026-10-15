# Design

Living document for the core systems. Sections marked *TBD* get filled in as each phase lands.

## Ground rules

- **No Blizzard data in git or builds.** Assets are converted per player from their own client into
  `cache/` (gitignored). The game server never serves game assets; it only sends game state.
- **Gameplay data source: VMaNGOS** world DB (GPL-2.0, `db_latest` SQLite release), imported at
  runtime from a local path and never committed. Where it is missing or unsuitable for an idle game,
  values are generated procedurally from creature level and type (hybrid, option c).
- **Multiplayer over a private VPN** (e.g. Tailscale). Every friend owns a 1.12.1 client.
- **Server-authoritative.** Never trust client timers; the shared simulation module is deterministic
  and seeded so the server resolves outcomes and clients replay them.

## Client data (Phase 0 recon, build 5875 enUS)

12 MPQs, 79,733 files after patch precedence. 136 DBCs. Counts: 123 skill lines, 5,072
skill-line abilities, 22,357 spells, 432 talents in 27 trees, 190 factions (54 with player reputation),
22 dungeon maps, 8 raid maps, 3 battlegrounds, 10,534 creature displays over 430 models,
29,604 item displays, 85 flight points.

The client does **not** contain creature stats, spawns, loot, item stats, quests or vendors.

## Asset pipeline (Phase 1)

`packages/assets`, dependency-free TypeScript:

| Format | Status |
|---|---|
| MPQ v0/v1 | done: hash/block tables, encryption, zlib + PKWare explode, patch precedence, delete markers |
| DBC (WDBC) | done |
| BLP2 | done: palettized (0/1/4/8-bit alpha), DXT1/3/5, raw BGRA |
| M2 v256 → glTF | done for creatures: mesh, embedded skin profile 0, skeleton, all sequences as clips, monster skin textures |
| WMO / ADT | not started |

Bone mapping: WoW animates `Parent · T(pivot) · T(t) · R · S · T(-pivot)`; each glTF joint sits at its
pivot with local transform `T(pivot − parentPivot + t) · R · S` and inverse bind `T(−pivot)`. A root
node rotates WoW Z-up into glTF Y-up. Clips are named from `AnimationData.dbc` (duplicates get `_1`,
`_2`). Death clips play once and hold.

Known gaps: environment-mapped overlay layers are skipped; global-sequence tracks are held at their
first key; hermite/bezier keys are played linearly; humanoid creatures (CreatureDisplayInfoExtra) and
player characters are not converted yet; GLBs are ~2.2 MB because every bone gets every channel in
every clip (to be slimmed).

## Idle formulas — *TBD (Phase 2)*
## XP curves — *TBD (Phase 2)*
## Group simulation model — *TBD (Phase 5)*
## Guild economy rules — *TBD (Phase 3)*

## Idleized content

| Content | Status |
|---|---|
| Everything | not started (Phase 2 begins with Elwynn Forest) |
