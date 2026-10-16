// Quests and reputation. Quests come from the world database: kill and collect objectives play out in
// the normal fight loop; everything the idle world can't model (talk to, deliver, use an object,
// escort) becomes a timed task you run like any other action.
import type { Faction, GameData, ItemId } from './data.js';
import { factionOfRace } from './data.js';
import { addItem, hasItem, log, type GameState, type Profession } from './state.js';

export interface QuestDef {
  id: number; name: string; level: number; minLevel: number;
  /** Zone you pick it up in, and zone you hand it in (the giver's and ender's homes). */
  zone: number; endZone: number;
  giver: string; ender: string;
  /** Who may take it: player races/classes bit masks (0 = anyone) and sides. */
  races: number; classes: number; sides: Faction[];
  skill?: [Profession, number];
  /** Must have completed this quest first. */
  prev?: number;
  /** Only one quest of an exclusive group can ever be completed. */
  exclusive?: number;
  /** The quest this one leads to (for the UI). */
  next?: number;
  kills: [number, number][];
  items: [ItemId, number][];
  /** A timed objective standing in for what idle play can't do; grants `grants` when finished. */
  task?: { ms: number; label: string; grants: [ItemId, number][] };
  xp: number; money: number;
  /** Money instead of experience at the level cap. */
  moneyMax: number;
  rewItems: [ItemId, number][]; choice: [ItemId, number][];
  rep: [number, number][];
  objectives: string;
}

/** Reputation standing ranks, as in the game. Thresholds are the lowest value of each rank. */
export const REP_RANKS = ['Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'] as const;
export const REP_MIN = [-42000, -6000, -3000, 0, 3000, 9000, 21000, 42000];
export const REP_CAP = 42999;

export interface FactionDef { id: number; name: string; parent: number; /** Starting standing per race. */ base: Record<number, number> }

export interface QuestProgress { kills: number[]; task: boolean }

export const QUEST_LOG_MAX = 20;

// ---------------------------------------------------------------- reputation

export function standing(s: GameState, data: GameData, faction: number): number {
  return (data.factions?.[faction]?.base[s.char.race] ?? 0) + (s.rep?.[faction] ?? 0);
}

export function repRank(value: number): number {
  for (let i = REP_MIN.length - 1; i >= 0; i--) if (value >= REP_MIN[i]) return i;
  return 0;
}

/** Changes standing, optionally not past the top of rank `maxRank` (kill reputation stops there). */
export function gainRep(s: GameState, data: GameData, faction: number, amount: number, maxRank = 7): number {
  if (!amount || !data.factions?.[faction]) return 0;
  const cur = standing(s, data, faction);
  const cap = maxRank >= 7 ? REP_CAP : REP_MIN[maxRank + 1] - 1;
  const delta = amount > 0 ? Math.max(0, Math.min(amount, cap - cur)) : Math.max(amount, REP_MIN[0] - cur);
  if (!delta) return 0;
  (s.rep ??= {})[faction] = (s.rep[faction] ?? 0) + delta;
  const before = repRank(cur), after = repRank(cur + delta);
  if (after !== before) log(s, 'info', `You are now ${REP_RANKS[after]} with ${data.factions[faction].name}.`);
  return delta;
}

// ---------------------------------------------------------------- quest rules

const raceBit = (race: number) => 1 << (race - 1);

/** Why the character can't take a quest right now, or null if they can (zone aside). */
export function questBlocked(s: GameState, data: GameData, q: QuestDef): string | null {
  if (s.questsDone.includes(q.id)) return 'Already completed.';
  if (s.quests[q.id]) return 'Already in your quest log.';
  if (s.char.level < q.minLevel) return `Requires level ${q.minLevel}.`;
  if (q.races && !(q.races & raceBit(s.char.race))) return 'Not offered to your race.';
  if (q.classes && !(q.classes & raceBit(s.char.cls))) return 'Not offered to your class.';
  if (!q.sides.includes(factionOfRace(data, s.char.race))) return 'Not offered to your faction.';
  if (q.prev && !s.questsDone.includes(q.prev)) return `Complete ${data.quests[q.prev]?.name ?? 'an earlier quest'} first.`;
  if (q.exclusive && s.questsDone.some(id => data.quests[id]?.exclusive === q.exclusive)) return 'You chose another path.';
  if (q.skill && (s.skills[q.skill[0]]?.level ?? 0) < q.skill[1]) return `Requires ${q.skill[0]} ${q.skill[1]}.`;
  return null;
}

/** Quests the character could pick up in a zone. */
export function availableQuests(s: GameState, data: GameData, zone = s.zone): QuestDef[] {
  return Object.values(data.quests ?? {}).filter(q => q.zone === zone && !questBlocked(s, data, q))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

export interface ObjectiveState { label: string; have: number; need: number }

export function questObjectives(s: GameState, data: GameData, id: number): ObjectiveState[] {
  const q = data.quests[id], p = s.quests[id];
  if (!q || !p) return [];
  return [
    ...q.kills.map(([c, n], i) => ({ label: `${data.creatures[c]?.name ?? 'Enemies'} slain`, have: Math.min(n, p.kills[i] ?? 0), need: n })),
    ...q.items.map(([it, n]) => ({ label: data.items[it]?.name ?? 'Item', have: Math.min(n, s.inventory[it] ?? 0), need: n })),
    ...(q.task ? [{ label: q.task.label, have: p.task ? 1 : 0, need: 1 }] : []),
  ];
}

export function questComplete(s: GameState, data: GameData, id: number): boolean {
  return !!s.quests[id] && questObjectives(s, data, id).every(o => o.have >= o.need);
}

/** Quests give more than in vanilla, since solo kills give less (see KILL_XP_RATE). */
export const QUEST_XP_RATE = 1.5;

/** Quest XP after the vanilla reduction for out-levelled quests. */
export function questXp(q: QuestDef, level: number): number {
  const diff = level - q.level;
  const f = diff <= 5 ? 1 : diff === 6 ? 0.8 : diff === 7 ? 0.6 : diff === 8 ? 0.4 : diff === 9 ? 0.2 : 0.1;
  return Math.round(q.xp * f * QUEST_XP_RATE);
}

/** Quest items still needed by the quest log (so quest-only drops can roll). */
export function neededQuestItems(s: GameState, data: GameData): Set<number> {
  const out = new Set<number>();
  for (const id of Object.keys(s.quests)) {
    for (const [it, n] of data.quests[+id]?.items ?? []) if ((s.inventory[it] ?? 0) < n) out.add(it);
  }
  return out;
}

/** Kill credit for every quest that wants this creature. */
export function creditKill(s: GameState, data: GameData, creature: number): void {
  for (const [id, p] of Object.entries(s.quests)) {
    const q = data.quests[+id];
    q?.kills.forEach(([c, n], i) => {
      if (c !== creature || (p.kills[i] ?? 0) >= n) return;
      p.kills[i] = (p.kills[i] ?? 0) + 1;
      if (p.kills[i] === n && questComplete(s, data, q.id)) log(s, 'info', `${q.name} is ready to hand in.`);
    });
  }
}

// ---------------------------------------------------------------- commands

type Result = { ok: true } | { ok: false; error: string };
const fail = (error: string): Result => ({ ok: false, error });

export function acceptQuest(s: GameState, data: GameData, id: number): Result {
  const q = data.quests?.[id];
  if (!q) return fail('Unknown quest.');
  const err = questBlocked(s, data, q);
  if (err) return fail(err);
  if (s.zone !== q.zone) return fail(`${q.giver} is in ${data.zones.find(z => z.id === q.zone)?.name ?? 'another zone'}.`);
  if (Object.keys(s.quests).length >= QUEST_LOG_MAX) return fail('Your quest log is full.');
  s.quests[id] = { kills: q.kills.map(() => 0), task: false };
  log(s, 'info', `Quest accepted: ${q.name}`);
  return { ok: true };
}

export function abandonQuest(s: GameState, data: GameData, id: number): Result {
  if (!s.quests[id]) return fail('Not in your quest log.');
  delete s.quests[id];
  if (s.action?.kind === 'quest' && s.action.quest === id) { s.action = null; s.phase = { p: 'idle' }; }
  log(s, 'info', `Quest abandoned: ${data.quests[id]?.name ?? id}`);
  return { ok: true };
}

/** Hand in a finished quest to its ender (in their zone), picking one of the choice rewards. */
export function turnInQuest(s: GameState, data: GameData, id: number, choice: number | undefined,
  gainXp: (xp: number) => void): Result {
  const q = data.quests[id];
  if (!q || !s.quests[id]) return fail('Not in your quest log.');
  if (!questComplete(s, data, id)) return fail('The quest is not complete yet.');
  if (s.zone !== q.endZone) return fail(`Hand it in to ${q.ender} in ${data.zones.find(z => z.id === q.endZone)?.name ?? 'another zone'}.`);
  if (q.choice.length && (choice === undefined || !q.choice.some(([it]) => it === choice))) return fail('Choose a reward.');
  for (const [it, n] of q.items) {
    if (!hasItem(s, it, n)) return fail(`You need ${n} ${data.items[it]?.name}.`);
  }
  for (const [it, n] of q.items) addItem(s, it, -n);
  delete s.quests[id];
  s.questsDone.push(id);
  for (const [it, n] of q.rewItems) addItem(s, it, n);
  const picked = q.choice.find(([it]) => it === choice);
  if (picked) addItem(s, picked[0], picked[1]);
  const atMax = s.char.level >= data.maxLevel;
  s.gold += Math.max(0, q.money) + (atMax ? q.moneyMax : 0);
  for (const [f, v] of q.rep) gainRep(s, data, f, v);
  log(s, 'info', `Quest completed: ${q.name}`);
  if (!atMax) gainXp(questXp(q, s.char.level));
  return { ok: true };
}

/** Which side a character is on, for team-dependent kill reputation. */
export const sideOf = (s: GameState, data: GameData): Faction => factionOfRace(data, s.char.race);
