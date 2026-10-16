# Design

Living document for the core systems. Sections marked *TBD* get filled in as each phase lands.

## Ground rules

- **No Blizzard data in git or builds.** Assets are converted per player from their own client into
  `cache/` (gitignored). The game server never serves game assets; it only sends game state.
- **Gameplay data source: VMaNGOS** world DB (GPL-2.0, `db_latest` SQLite release), downloaded to
  `data/vmangos/` (gitignored) and imported locally. What decides *what exists* (skills, recipe skill
  thresholds, zones, icons, models, talents, factions) comes from the client DBCs; what the client never
  had (stats, spawns, loot, vendors, trainers, quests) comes from VMaNGOS, pinned to patch 1.12.
  Procedural values only fill gaps (hybrid, option c).
- **Multiplayer over a private VPN** (e.g. Tailscale). Every friend owns a 1.12.1 client and runs
  the converter locally.
- **Server-authoritative (from Phase 3).** The shared simulation is deterministic and seeded, so the
  server resolves outcomes and clients replay them.

### Game-feel decisions

| Decision | Choice |
|---|---|
| Offline progress cap | **24 hours.** Time beyond the cap is skipped, not simulated. |
| Gold | **Personal purse** (vendors, trainers) **plus a guild bank** (Phase 3). |
| Characters per account | **One.** |
| Guild | One guild, **"Idle Hands"**; every account joins on creation. **Alliance and Horde share it** (Phase 4). |
| Guild bank | **Free deposits and withdrawals for everyone, fully logged.** |
| Activity feed | **Level milestones (every 10 levels), rare/elite kills, profession rank-ups**, joins. No loot announcements. |
| Game data to friends | **The server sends it**; friends convert only art, from their own client. |
| Classes | **Real spells, cast by an automatic rotation**; real talent effects (Phase 4). |
| Travel | **Takes minutes**: running, flight paths, boats/zeppelins, riding (Phase 4). |
| Quest objectives | Kills and drops play out in fights; **everything else becomes a timed task** (Phase 4). |
| Healing | **Food heals; nothing else does between fights.** Natural regeneration is 1 HP per minute, so fishing and cooking are what keep a fighter going; Apprentice Cooking, Fishing and First Aid are free from level 1 (Phase 4). |
| Professions | **Two primary professions** at a time (vanilla rule), unlearnable; secondary skills are free (Phase 4c). |
| Dungeon groups | **NPC hirelings fill empty slots** (weaker than geared players), so two friends can run a 5-man (Phase 5). |
| Dungeon loot | **Need before greed**: members who can use an item roll Need and beat Greed rolls; hirelings never roll (Phase 5). |
| Dungeon time | **Characters are busy for the run** (its simulated length, tens of minutes), then the rewards arrive (Phase 5). |

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

`npm run assets -- import` builds `cache/data/game.json` (~12 MB: 45 zones, ~9,300 items, 916 recipes,
2,613 quests, class spells and talents). `npm run assets -- art` converts UI art, icons and character
models eagerly; creature models and item icons are converted on first request (lazily) by the launcher
or the dev server.

## Simulation (`packages/sim`)

Event-driven: `advance(state, data, t)` resolves discrete events (search ends, swings, casts, ticks,
deaths) in time order until `t`, drawing every random number from an sfc32 RNG whose state lives
in the save. **Same state + same target time = same result**, regardless of how the time is chunked
(tested: 1 big step ≡ thousands of small ones; offline catch-up ≡ online play; casters included).

Health, mana and energy change in whole points on ticks aligned to absolute time (food and power every
2 s, natural health regeneration every 60 s), which is what makes chunking irrelevant.

### Combat

| Piece | Formula |
|---|---|
| Kill XP | MaNGOS `BaseGain`: mob ≥ you: `((5L+45)·(20+min(diff,4))/10+1)/2`; below: `(5L+45)·(ZD+mob−L)/ZD` until gray; elites ×2 |
| Gray level | L≤5: 0; ≤39: L−5−⌊L/10⌋; ≤59: L−1−⌊L/5⌋; else L−9 |
| XP to level | `player_xp_for_level` (VMaNGOS) |
| Player HP | class base HP + stamina (first 20 → 1 HP each, then 10 HP each) |
| Mana | class base mana + intellect (first 20 → 1 each, then 15 each); regen per 2 s tick from spirit (per class), only outside the five-second rule |
| Rage / energy | rage from damage dealt and taken (vanilla formula), fades out of combat; energy 20 per 2 s, cap 100 |
| Attack power | per class, vanilla formulas (e.g. warrior/paladin `2·Str + 3·L − 20`) |
| Swing damage | weapon min–max (unarmed 1–2) + AP/14 × speed |
| Miss | weapon skill vs defense: `5% + 0.1%·(def − skill)` up to 10 points apart, then `7% + 0.4%` per point |
| Weapon skills / Defense | rise with use up to 5 × level (vanilla chance curve); class proficiencies from SkillRaceClassInfo |
| Dodge | mob: 5% + 0.1% per level above you; player: Agi/20 % (+ defense) |
| Crit | melee 5% + Agi/20 %, spell 5% + Int/60 %, mob 5%; crits double (spells ×1.5) |
| Armor | reduction `A / (A + 400 + 85·attackerLevel)`, max 75% |
| Mob stats | VMaNGOS `creature_classlevelstats` × template multipliers; damage is per hit at a 2.0 s swing, scaled by attack time |
| Healing between fights | **food only** (eat to full); without food you wait (1 HP/min) until the rest threshold |
| Potions | healing potions drunk automatically below 35% HP in a fight, 2 min shared cooldown |
| Death | 30 s corpse run, resurrect at 10% HP |

### Class spells and the rotation (Phase 4b)

Every class spell rank comes from trainer data plus the client's spell table, normalized into a small
effect set: direct damage/heal, weapon strikes (flat or %), DoT/HoT, channels, absorb shields,
self buffs (stats, AP, armor, haste), seals, thorns, combo points, energize, conjure food/water.
Spells the idle fight can't use (pets, totems, crowd control, ranged-slot shots) are left out.

The rotation runs on GCD/cast/cooldown timers: it heals when hurt, keeps buffs and seals up (they're
passive while known), and otherwise casts the affordable spell with the best expected damage per
second of cast, spending combo points at 5 (or when the mob is nearly dead). Proc abilities
(Overpower, Revenge, Riposte, Execute) are used when their condition holds. Melee classes keep
swinging; next-swing abilities (Heroic Strike) replace a swing.

Spells are trained at a class trainer (zones from VMaNGOS trainer spawns) at their vanilla costs.

### Talents (Phase 4b)

Trees from Talent.dbc/TalentTab.dbc: 5 points per row, prerequisites, one point per level from 10.
Each rank spell's auras become effects: flat/% stats, health/mana %, melee/spell crit and hit, dodge,
armor, attack power, school damage %, and **spell modifiers** (damage, crit, cast time, cost,
cooldown) that select spells the way the game does — by spell family and family-flag mask. 146 of
the 432 talents change idle combat; the rest say so in their tooltip. Respec costs 1g, then 5g more
each time up to 50g.

### Travel (Phase 4a)

Zone-to-zone travel takes real minutes: running at 7 yd/s between zone centres (or neighbouring flight
masters), boats/zeppelins at 3 minutes per crossing, flight paths at 32 yd/s along the taxi network
(Dijkstra over discovered nodes, at their real costs). Riding: +60% at level 40 (90g), +100% at 60 (900g).

### Professions (Phase 4c)

Skills are WoW skill points (1–300), not XP. Ranks (Apprentice 75 → Artisan 300) are bought from
trainers with the costs and level requirements from VMaNGOS trainer data; the next rank needs
skill ≥ cap − 25. Two primary professions at a time; unlearning forgets the skill and its recipes.

| Skill | Action | Skill-up |
|---|---|---|
| Mining / Herbalism | 5 s per node (walk + gather), one loot roll | orange 100% · yellow 75% · green 25% · grey 0% (node colours: req, +25, +50, +100) |
| Skinning | automatic on every beast you kill (knife needed); needs `L<10: 1, L<20: (L−10)·10, else 5·L` | same colour chances |
| Fishing | 5–18 s bobber; catch if `skill − zoneSkill + 5 > roll` | 100% below 75, then `2500/(skill−50)` % per catch |
| Crafting (all) | recipe cast time + 0.5 s; consumes reagents; repeat until out or a count | colour chances, thresholds from SkillLineAbility.dbc |
| Disenchanting | instant; uncommon+ gear → `disenchant_loot_template` | needs `25·⌈(itemLevel−20)/5⌉` |

Recipes: every SkillLineAbility create-item or enchant spell with reagents, accepted only if the
world can supply the reagents. Intermediates count (bars, bolts, leather) because recipes are
resolved to a fixed point. Tools (Blacksmith Hammer, Arclight Spanner, Runed Rods) come from the
spell's totem fields. Enchantments go on one of your equipped items (the first that fits, or one you
pick) and add their stats; they fall off when the item is replaced. Bandages heal between fights like
food.

Loot uses MaNGOS semantics: ungrouped entries roll independently; a group yields at most one entry
(explicit chances first, then an even split among 0-chance entries); references resolve recursively.
Quest-only drops roll only while a quest in your log still needs them.

### Quests and reputation (Phase 4d)

2,613 quests from `quest_template`, picked up where the giver stands and handed in where the ender
stands (their spawn zones; you travel there). Requirements: level, race, class, side, profession
skill, previous quest, exclusive groups. Rewards: XP with the vanilla reduction for out-levelled
quests (−20% per level beyond +5, floor 10%), money (money instead of XP at 60), items with a choice,
reputation. Log of 20.

Objectives: **kills** count in the normal fight loop; **items** drop from creatures (quest-only drops
included); everything else — talk to, deliver, use an object, cast on a target, enemies or quest items
the idle world doesn't spawn — becomes a **timed task** (30 s base plus per-objective time, capped at
10 minutes) that you run as an action. Tasks only ever hand out quest items, so they can't be used to
skip earning real items. Dungeon, raid, PvP and world-event quests are left for later phases.

Reputation: factions and racial starting standing from Faction.dbc; gained from quests and kills
(`creature_onkill_reputation`, which stops at its max rank, team-dependent where marked). Some vendor
items need a standing.

### Known balance notes

- Kill pace is quick (~220–350 kills/hour at level 1–5 with spells) next to vanilla. To revisit in
  Phase 7, together with quest XP vs grinding.

## Server (`apps/server`, Phase 3)

Node + TypeScript, `ws` for WebSockets, SQLite (`better-sqlite3`) in `data/server/`.

**Authority.** The server holds every character's `GameState` and is the only thing that changes it.
Players send `Command`s (`start`, `stop`, `train`, `buy`, `equip`, `trainSpells`, `learnTalent`,
`acceptQuest`, `turnInQuest`, …); the server shape-checks them (`parseCommand`), applies them with the
same `applyCommand` the sim exports, and sends back a state snapshot. Clients never send state.
Older saves are brought up to date on load (`migrateState`).

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
`GET /api/gamedata` (gzip, with ETag), `GET /api/health`; WebSocket `/ws` with `auth`, `create`, `cmd`,
`chat`, `bank`, `request`, `order` from clients and `hello`, `state`, `away`, `result`, `guild`, `chat`,
`feed` from the server.

## Guild economy

| Piece | Rules |
|---|---|
| Membership | Automatic on character creation (either faction). Roster shows online status, level, race/class and live activity. |
| Personal gold | Each character's purse: vendors, trainers, respecs, riding. |
| Guild bank | Items and gold. Anyone may deposit or withdraw; every transaction is logged (who, what, when). |
| Requests | "Need 20 Copper Ore": up to 10 open per member. Another member fills it by sending items straight to the requester (logged as a "fill"); partial fills allowed; it closes when complete; the requester can cancel. |
| Crafting orders (Phase 4c) | Order N crafts of any item recipe; optionally hand over the reagents and a tip, which the guild holds. A member who knows the recipe claims it (receiving the reagents), crafts, and delivers: the items go to the buyer, the tip to the crafter, and it's logged. Unclaimed orders can be cancelled (escrow returned); a crafter can give an order up by returning the reagents. |
| Chat | Guild chat, 300 characters, 5 messages per 10 s per member; last 60 kept in the snapshot. |
| Activity feed | Joins; level milestones (10, 20, …); rare/elite/boss kills (once per creature per member per 30 min); profession rank-ups. |

Not yet: guild achievements/perks.

## Client (`apps/game`)

React panels (Melvor-style) + a three.js diorama, talking to the guild server (log in with the
server's address). Pages: combat, quests, every profession, spellbook/trainer, talents, equipment,
bags, reputation, travel, trainers & vendors, guild, log. The diorama renders at full rate when
focused, ~5 fps when blurred and not at all while the tab is hidden; models load lazily and are cached.
Floating combat text names the spell and shows heals. It reconnects automatically if the server
restarts.

## Dungeons and the group simulation (Phase 5)

**Dungeons from data.** The 5-man instances come from LFGDungeons.dbc (names, level ranges) matched to
Map.dbc; their creatures are the VMaNGOS spawns on each instance map. Bosses are found, not listed:
elites that spawn once and have at least two uncommon-or-better items that really drop (≥3%,
following loot references). Instances with several runs are split into wings around each wing's
final boss (Scarlet Monastery's four wings, Dire Maul East/West/North, Stratholme Live/Undead, Lower
and Upper Blackrock Spire; UBRS is a 10-player run). A run is ordered from the entrance (the spawn
farthest from the final boss) toward the final boss; trash is clustered into packs (18 yd) and up to
four packs guard each boss. 25 runs from Ragefire Chasm to Scholomance; dungeon quests (type 81) are
back, credited by runs.

**Boss mechanics from data.** Each creature's VMaNGOS spell list (creature_spells: spell, target,
timers, chance) is normalized into abilities: direct and area damage by school, damage over time,
crowd control, self-heals, enrages, summoned adds, extra attacks and knockbacks (the tank loses the
mob for 1.5 s). Spell damage is reduced by the target's resistance (vanilla's average:
`min(75%, R / (5 · level) · 75%)`), so fire/shadow/nature resistance gear matters.

**Snapshots.** When the leader starts, every member's character is snapshotted: role, health, armor,
dodge and Defense, resistances, damage per second *measured* by fighting a training dummy for 40 s
with the real fight engine (their spells, talents, gear and mana), and every spammable heal rank
they know (healers down-rank: the cheapest heal that covers the missing health). Empty slots get
hirelings (a tank and a healer first): a warrior, priest or mage of the group's level in the best
green/blue items their class can use at that level, at 80% power.

**The fight.** 1-second steps. Damage dealers hit the focus target; the healer casts real heal ranks
with cast times, mana (little regeneration while casting) and spell pushback; the tank holds the
mobs — if the tank is dead, crowd-controlled or knocked back, mobs hit the healer (healing draws
threat) or anyone. At most three mobs fight at once (the rest are crowd-controlled). Mob melee uses
the same miss/dodge/armor formulas as solo combat. Between pulls: 20 s walking, 15 s resting (full
health and mana). A wiped pull is retried twice (90 s corpse run each); the third wipe ends the run.
Result: whether it cleared, how far it got, its length, kills, per-member experience (kill XP × the
vanilla group bonus 1.4 for five, split), gold, and loot.

**Loot.** Each boss's loot is rolled once; per item, members who can use it (weapon/armor
proficiency, level) roll Need, everyone else Greed; highest Need wins, else highest Greed; hirelings
never roll. Trash gold is shared. Each member also rolls their own quest-only drops from the kills.

**Async play.** Members sign up on the guild's group board with a role their class can fill; the
leader starts whenever they like (no one needs to be online). The server simulates the run at once
and stores it; members are busy (`dungeon` action) for its simulated length, and the rewards
arrive when it ends. Everyone can watch the run as a 3D replay: the party in their real looks and
gear against the real creature models, with health bars, floating numbers and a combat log, at
1×/4×/16×.

Balance (hireling-only groups, dev/dungeon-balance.ts): full groups clear most dungeons at level; with
no healer or no tank most runs wipe early. The hardest level-60 runs (Scholomance, Lower Blackrock
Spire, Stratholme Undead) need better-than-hireling gear. To revisit in Phase 7.

## Idleized content

| Content | Status |
|---|---|
| Both continents: 45 zones, creatures with real stats/loot, vendors, flight paths, boats | done (Phase 4a) |
| Both factions, all races and classes | done (Phase 4a) |
| Class spells, automatic rotation, talents, weapon skills, defense | done (Phase 4b) |
| All professions, recipes, enchanting, disenchanting, skinning, potions, bandages | done (Phase 4c) |
| Guild: server, accounts, roster, bank, requests, crafting orders, chat, feed | done (Phases 3, 4c) |
| Quests (non-instance), reputation | done (Phase 4d) |
| Playtest feedback: filtering, categories, activity scenes, visible gear | done (Phase 4e) |
| Dungeons (25 runs incl. UBRS 10-player), group simulation, need-before-greed loot, 3D replays | done (Phase 5) |
| Raids, world bosses, PvP | Phases 6, later |

### Phase 4e — playtest feedback

From playing Phase 4 with the guild:

- **Categories and filters.** Items fall into categories (weapons, armor, consumables, trade goods,
  tools, recipes, quest items, containers, ammo, junk) from their class, quality and what recipes use
  them. Bags, vendors and the guild bank get a search box and category chips, grouped by category;
  quests and the spellbook get a search box (recipes already had one). Tools such as the Blacksmith
  Hammer show under Tools at every vendor that sells them.
- **A scene for every activity.** One diorama follows whatever the character does: fighting; mining
  or gathering the node's own model (from GameObjectDisplayInfo); fishing at a pond with the real
  bobber; crafting at a station (campfire, anvil, forge, alchemy set, gnome machine, workbench)
  with a fitting animation; skinning kneels at the corpse; quest tasks and travel animate too. While
  fishing or mining the character holds the pole or pick from their bags.
- **Gear on the character.** Equipped armor is composited onto the body texture region by region
  (ItemDisplayInfo texture components, male/female/unisex), geosets follow the item rules (sleeves,
  gloves, boots, robe skirts, capes, tabards), most helmets hide the hair, and helmets (per race and
  sex), shoulders, weapons and shields are attached to the character's M2 attachment points.
  Item art and game-object models convert on demand (`items/`, `objects/` in the cache).

### Known gaps

- Some dungeon bosses aren't detected (Rhahk'Zor, several in Zul'Farrak) because their loot is thin;
  scripted encounters (VanCleef's adds, Balnazzar's transformation) are plain fights. Groups can't yet
  be watched live by everyone at the same moment (the replay is available as soon as the run starts).
- Lockpicking, pets (hunter/warlock), totems, poisons/imbues and crowd control aren't idleized yet;
  hunters fight in melee until ranged weapons arrive.
- Profession specializations (Elemental/Dragonscale, Gnomish/Goblin, ...) and their reputations.
- Belts, bracers' own models and enchant glows aren't shown on characters; humanoid NPCs still use
  their baked body textures (their weapons aren't attached yet).
- Environment-mapped overlay layers are skipped; global-sequence tracks are held at their first key;
  hermite/bezier keys play linearly.
- Bags have no slot limit yet.
- The launcher exe isn't code-signed, so Windows SmartScreen warns on first run.

## Launcher (`apps/launcher`)

A Node single-executable app (`npm run build:launcher` → `release/IdlecraftLauncher.exe`):
first-run setup (WoW folder, server address), art conversion from the player's own client into
`idlecraft-cache/` keyed by the server's data version (creature models and item icons converted on
first use), and a localhost web server for the embedded client build + that cache. The build script
refuses to embed anything but HTML/JS/CSS, and the game's Vite config gives production builds no public
dir, so converted art can't end up in a distributable.
