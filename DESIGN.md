# Design

Living document for the core systems. Sections marked *TBD* get filled in as each phase lands.

## Ground rules

- **No Blizzard data in git or builds.** Assets are converted per player from their own client into
  `cache/` (gitignored). The game server never serves game assets; it only sends game state.
- **Gameplay data source: VMaNGOS** world DB (GPL-2.0, `db_latest` SQLite release), downloaded to
  `data/vmangos/` (gitignored) and imported locally. What decides *what exists* (skills, recipe skill
  thresholds, zones, icons, models) comes from the client DBCs; what the client never had (stats,
  spawns, loot, vendors, trainers) comes from VMaNGOS, pinned to patch 1.12. Procedural values only
  fill gaps (hybrid, option c).
- **Multiplayer over a private VPN** (e.g. Tailscale). Every friend owns a 1.12.1 client and runs
  the converter locally.
- **Server-authoritative (from Phase 3).** The shared simulation is deterministic and seeded, so the
  server resolves outcomes and clients replay them. In Phase 2 the browser runs it locally.

### Game-feel decisions

| Decision | Choice |
|---|---|
| Offline progress cap | **24 hours.** Time beyond the cap is skipped, not simulated. |
| Gold | **Personal purse** (vendors, trainers) **plus a guild bank** (Phase 3). |
| Characters per account | **One.** |
| Guild | One guild, **"Idle Hands"**; every account joins on creation. |
| Guild bank | **Free deposits and withdrawals for everyone, fully logged.** |
| Activity feed | **Level milestones (every 10 levels), rare/elite kills, profession rank-ups**, joins. No loot announcements. |
| Game data to friends | **The server sends it**; friends convert only art, from their own client. |

## Client data (Phase 0 recon, build 5875 enUS)

12 MPQs, 79,733 files after patch precedence. 136 DBCs. Counts: 123 skill lines, 5,072
skill-line abilities, 22,357 spells, 432 talents in 27 trees, 190 factions (54 with player reputation),
22 dungeon maps, 8 raid maps, 3 battlegrounds, 10,534 creature displays over 430 models,
29,604 item displays, 85 flight points.

## Asset pipeline

`packages/assets`, dependency-free TypeScript (plus `better-sqlite3` for the importer).

| Format | Status |
|---|---|
| MPQ v0/v1 | done: hash/block tables, encryption, zlib + PKWare explode, patch precedence, delete markers |
| DBC (WDBC) | done |
| BLP2 | done: palettized (0/1/4/8-bit alpha), DXT1/3/5, raw BGRA |
| M2 v256 → glTF | done: mesh, embedded skin profile, skeleton, clips, creature skins, geoset ids, texture-type tags |
| ADT | area id per terrain chunk (zone lookup); terrain meshes not yet |
| WMO | not started |

Bone mapping: WoW animates `Parent · T(pivot) · T(t) · R · S · T(-pivot)`; each glTF joint sits at its
pivot with local transform `T(pivot − parentPivot + t) · R · S` and inverse bind `T(−pivot)`. A root
node rotates WoW Z-up into glTF Y-up. Only animated properties get channels; animated properties get a
constant key in clips that don't move them. Character models keep only the clips the game uses
(combat, gathering, eating, fishing, casting), which cut them from ~21 MB to ~2.5 MB each.

**Characters** are assembled at runtime in the client: a race model with every geoset, plus the
CharSections pieces composited on a 256×256 canvas (skin → face → facial hair → scalp → underwear) and
the hair texture. Geosets: hair from CharHairGeosets, facial hair from CharacterFacialHairStyles,
defaults 401/501/702/1301/1501. **Humanoid NPCs** (CreatureDisplayInfoExtra) use the same race model
with their pre-baked body texture and the geosets their equipped items imply (sleeves, gloves, boots,
robes, tabard).

**Zone lookup:** spawn coordinates → ADT tile/chunk → the chunk's area id → AreaTable parent chain
→ zone. Same data the client uses to name the zone you stand in.

`npm run assets -- import` builds `cache/data/game.json`, icons, UI art, fonts, Elwynn scenery,
character and creature models. Whole Elwynn cache: ~95 MB.

## Simulation (`packages/sim`)

Event-driven: `advance(state, data, t)` resolves discrete events (search ends, swings, deaths, casts
completing) in time order until `t`, drawing every random number from an sfc32 RNG whose state lives
in the save. **Same state + same target time = same result**, regardless of how the time is chunked
(tested: 1 big step ≡ thousands of small ones; offline catch-up ≡ online play).

Health regenerates in whole points on 2-second ticks aligned to absolute time, which is what makes
chunking irrelevant.

### Combat (idle auto-attack)

| Piece | Formula |
|---|---|
| Kill XP | MaNGOS `BaseGain`: mob ≥ you: `((5L+45)·(20+min(diff,4))/10+1)/2`; below: `(5L+45)·(ZD+mob−L)/ZD` until gray; elites ×2 |
| Gray level | L≤5: 0; ≤39: L−5−⌊L/10⌋; ≤59: L−1−⌊L/5⌋; else L−9 |
| XP to level | `player_xp_for_level` (VMaNGOS) |
| Player HP | class base HP + stamina (first 20 → 1 HP each, then 10 HP each) |
| Attack power | per class, vanilla formulas (e.g. warrior/paladin `2·Str + 3·L − 20`) |
| Swing damage | weapon min–max (unarmed 1–2) + AP/14 × speed |
| Miss | `5% + 0.1%·(def − skill)` up to 10 points apart, then `7% + 0.4%` per point; skill/defense = 5 × level |
| Dodge | mob: 5% + 0.1% per level above you; player: Agi/20 % |
| Crit | player 5% + Agi/20 %, mob 5%; crits double |
| Armor | reduction `A / (A + 400 + 85·attackerLevel)`, max 75% |
| Mob stats | VMaNGOS `creature_classlevelstats` × template multipliers; damage is per hit at a 2.0 s swing, scaled by attack time |
| Out-of-combat regen | `Spi/4 + 3` HP per second (approximation of spirit regen) |
| Search | 2.5–4.5 s between mobs |
| Resting | below 60% HP after a kill; eats the smallest food that tops you up when below 50% (toggle in settings) |
| Death | 30 s corpse run, resurrect at 50% HP |

### Professions

Skills are WoW skill points (1–300), not XP. Ranks (Apprentice 75 → Artisan 300) are bought from
trainers with the costs and level requirements from VMaNGOS trainer data, and the next rank needs
skill ≥ cap − 25.

| Skill | Action | Skill-up |
|---|---|---|
| Mining / Herbalism | 5 s per node (walk + gather), one loot roll | orange 100% · yellow 75% · green 25% · grey 0% (node colours: req, +25, +50, +100) |
| Fishing | 5–18 s bobber; catch if `skill − zoneSkill + 5 > roll` | 100% below 75, then `2500/(skill−50)` % per catch |
| Cooking | recipe cast time + 0.5 s; consumes reagents | same colour chances; thresholds from SkillLineAbility.dbc |

Mining needs a Mining Pick, fishing a Fishing Pole (both sold in Elwynn). Starter recipes come with the
skill; others are bought from trainers or learned from recipe items.

Loot uses MaNGOS semantics: ungrouped entries roll independently; a group yields at most one entry
(explicit chances first, then an even split among 0-chance entries); references resolve recursively.
Quest-only drops are skipped until quests exist.

### Known balance notes

- Kill pace is quick (~12 s per kill at even level including search and rest) next to vanilla.
  To revisit in Phase 7.
- Every class currently fights with weapon auto-attacks; spells and talents arrive with Phase 4.

## Server (`apps/server`, Phase 3)

Node + TypeScript, `ws` for WebSockets, SQLite (`better-sqlite3`) in `data/server/`.

**Authority.** The server holds every character's `GameState` and is the only thing that changes it.
Players send `Command`s (`start`, `stop`, `train`, `buy`, `sell`, `equip`, …); the server shape-checks
them (`parseCommand`), applies them with the same `applyCommand` the sim exports, and sends back a
state snapshot. Clients never send state.

**Ticks.** Every second the server advances every character to its *horizon*:

- online → now;
- offline → `min(now, lastSeen + 24h)`.

So an offline character keeps fighting/gathering for 24 hours after its player was last connected,
then pauses. When the player returns, the server finishes the window, reports it ("While you were
away", from the events it simulated), and resumes from now — the time beyond the cap is skipped, not
simulated. Characters are saved every 10 s and on shutdown.

**Client replay.** The client keeps the latest snapshot and runs the same deterministic sim locally up
to *server time* (clock offset from each message) to drive the UI and 3D animation. Because the sim is
deterministic, the replay matches what the server computes; a fresh snapshot arrives after every
command and every 30 s anyway. Commands are also previewed locally for instant feedback; the server's
snapshot is the truth. Sim events already shown are not repeated after a resync.

**Accounts.** Username + password (scrypt), opaque 32-byte session tokens. One character per account.
`?profile=name` in the client URL keeps a separate login per browser tab (for testing).

**Protocol** (`packages/sim/src/protocol.ts`): HTTP `POST /api/register|login|logout`,
`GET /api/gamedata` (with ETag), `GET /api/health`; WebSocket `/ws` with `auth`, `create`, `cmd`,
`chat`, `bank`, `request` from clients and `hello`, `state`, `away`, `result`, `guild`, `chat`, `feed`
from the server.

## Guild economy (Phase 3)

| Piece | Rules |
|---|---|
| Membership | Automatic on character creation. Roster shows online status, level, race/class and live activity. |
| Personal gold | Each character's purse: vendors, trainers. |
| Guild bank | Items and gold. Anyone may deposit or withdraw; every transaction is logged (who, what, when). |
| Requests | "Need 20 Copper Ore": up to 10 open per member. Another member fills it by sending items straight to the requester (logged as a "fill"); partial fills allowed; it closes when complete; the requester can cancel. |
| Chat | Guild chat, 300 characters, 5 messages per 10 s per member; last 60 kept in the snapshot. |
| Activity feed | Joins; level milestones (10, 20, …); rare/elite/boss kills (once per creature per member per 30 min); profession rank-ups. |

Not yet: crafting orders (one member crafting for another from shared materials) arrive with more
professions in Phase 4; guild achievements/perks later.

## Client (`apps/game`)

React panels (Melvor-style) + a three.js diorama, talking to the guild server (log in with the
server's address). The diorama renders at full rate when focused, ~5 fps when blurred and not at all
while the tab is hidden; models load lazily and are cached. It reconnects automatically if the server
restarts.

## Idle formulas, group simulation — *TBD (Phases 4–6)*

## Idleized content

| Content | Status |
|---|---|
| Elwynn Forest combat (46 creature types incl. rares and Hogger) | done |
| Mining, Herbalism (Elwynn nodes), Fishing (Elwynn pools), Cooking (6 recipes) | done |
| Vendors (Elwynn), profession trainers | done |
| Inventory, equipment (stats, armor, weapons) | done (no class/proficiency checks yet) |
| Character creation with appearance | done (Alliance races) |
| Guild: server, accounts, roster, bank, requests, chat, feed | done (Phase 3) |
| Other zones, quests, reputation, all other skills, crafting orders | Phase 4 |
| Dungeons, raids | Phases 5, 6 |

### Known gaps

- Helmets, shoulders and weapons aren't attached to models yet; player gear doesn't change the
  player's look yet (the texture compositor is ready for it).
- Environment-mapped overlay layers are skipped; global-sequence tracks are held at their first key;
  hermite/bezier keys play linearly.
- Bags have no slot limit yet.
- Friends run the client from a copy of the repo (`npm run game`); a one-click launcher is future polish.
