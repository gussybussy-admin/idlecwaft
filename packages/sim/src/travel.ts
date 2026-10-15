// Travel between zones. Real distances between zone centres at run speed ("minutes" per hop),
// boats/zeppelins between continents, flight paths over discovered nodes, and Riding.
import type { Copper, Faction, GameData, ZoneDef } from './data.js';
import { factionOfRace } from './data.js';
import type { GameState } from './state.js';
import { log } from './state.js';

export const RUN_SPEED = 7;     // yards per second on foot
export const FLY_SPEED = 32;    // yards per second on a flight path
export const BOAT_MS = 3 * 60_000; // a crossing including the wait at the dock

/** Riding ranks: speed bonus, level, total cost (training + a mount). */
export const RIDING = [
  { name: 'Apprentice Riding', bonus: 60, reqLevel: 40, cost: 90_0000 },
  { name: 'Journeyman Riding', bonus: 100, reqLevel: 60, cost: 900_0000 },
] as const;

/** Boat and zeppelin routes between the continents, by zone, with who may use them. */
export const CROSSINGS: { a: number; b: number; name: string; factions: Faction[] }[] = [
  { a: 11, b: 15, name: 'Menethil Harbor – Theramore boat', factions: ['alliance'] },
  { a: 11, b: 148, name: 'Menethil Harbor – Auberdine boat', factions: ['alliance'] },
  { a: 33, b: 17, name: 'Booty Bay – Ratchet boat', factions: ['alliance', 'horde'] },
  { a: 85, b: 14, name: 'Undercity – Orgrimmar zeppelin', factions: ['horde'] },
  { a: 33, b: 14, name: 'Grom\'gol – Orgrimmar zeppelin', factions: ['horde'] },
];

export interface TravelLeg { kind: 'walk' | 'fly' | 'boat'; ms: number; label: string }
export interface TravelPlan { ms: number; cost: Copper; legs: TravelLeg[] }

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const zoneById = (data: GameData, id: number) => data.zones.find(z => z.id === id);

export function speedYps(s: GameState): number {
  return RUN_SPEED * (1 + s.riding / 100);
}

/** Best way between two zones on the same continent: walk, or walk–fly–walk over known nodes. */
function sameMap(s: GameState, data: GameData, from: ZoneDef, to: ZoneDef, faction: Faction): TravelPlan {
  const v = speedYps(s);
  const walk: TravelPlan = { ms: Math.round(dist(from.x, from.y, to.x, to.y) / v * 1000), cost: 0,
    legs: [{ kind: 'walk', ms: 0, label: `Run to ${to.name}` }] };
  walk.legs[0].ms = walk.ms;
  if (from.id === to.id) return { ms: 0, cost: 0, legs: [] };

  const known = new Set(s.taxi.filter(id => data.taxiNodes[id]?.factions.includes(faction) && data.taxiNodes[id].map === from.map));
  const starts = from.taxiNodes.filter(id => known.has(id));
  if (!starts.length) return walk;
  // Dijkstra over flight paths between known nodes, by length.
  const best = new Map<number, { len: number; cost: number }>();
  const queue: { node: number; len: number; cost: number }[] = [];
  for (const id of starts) {
    const n = data.taxiNodes[id];
    const lead = dist(from.x, from.y, n.x, n.y) / v * 1000;
    queue.push({ node: id, len: lead * FLY_SPEED / 1000, cost: 0 }); // express the lead-in as flight-equivalent yards
  }
  while (queue.length) {
    queue.sort((a, b) => a.len - b.len);
    const cur = queue.shift()!;
    if (best.has(cur.node)) continue;
    best.set(cur.node, { len: cur.len, cost: cur.cost });
    for (const p of data.taxiPaths) {
      if (p.from !== cur.node || !known.has(p.to) || best.has(p.to)) continue;
      queue.push({ node: p.to, len: cur.len + p.length, cost: cur.cost + p.cost });
    }
  }
  let plan = walk;
  for (const [node, b] of best) {
    if (starts.includes(node)) continue;
    const n = data.taxiNodes[node];
    const tail = dist(n.x, n.y, to.x, to.y) / v * 1000;
    const ms = Math.round(b.len / FLY_SPEED * 1000 + tail);
    if (ms < plan.ms) {
      plan = { ms, cost: b.cost, legs: [
        { kind: 'fly', ms: Math.round(b.len / FLY_SPEED * 1000), label: `Fly to ${n.name}` },
        { kind: 'walk', ms: Math.round(tail), label: `Ride to ${to.name}` },
      ] };
    }
  }
  return plan;
}

export function planTravel(s: GameState, data: GameData, toZone: number): TravelPlan | null {
  const from = zoneById(data, s.zone), to = zoneById(data, toZone);
  if (!from || !to) return null;
  const faction = factionOfRace(data, s.char.race);
  if (from.map === to.map) return sameMap(s, data, from, to, faction);
  let best: TravelPlan | null = null;
  for (const c of CROSSINGS) {
    if (!c.factions.includes(faction)) continue;
    for (const [here, there] of [[c.a, c.b], [c.b, c.a]]) {
      const portA = zoneById(data, here), portB = zoneById(data, there);
      if (!portA || !portB || portA.map !== from.map || portB.map !== to.map) continue;
      const a = sameMap(s, data, from, portA, faction), b = sameMap(s, data, portB, to, faction);
      const ms = a.ms + BOAT_MS + b.ms;
      if (!best || ms < best.ms) {
        best = { ms, cost: a.cost + b.cost, legs: [...a.legs, { kind: 'boat', ms: BOAT_MS, label: c.name }, ...b.legs] };
      }
    }
  }
  return best;
}

/** Learn every flight path in the zone you're standing in (vanilla: talk to the flight master). */
export function discoverTaxis(s: GameState, data: GameData): number[] {
  const zone = zoneById(data, s.zone);
  const faction = factionOfRace(data, s.char.race);
  const found: number[] = [];
  for (const id of zone?.taxiNodes ?? []) {
    if (!s.taxi.includes(id) && data.taxiNodes[id]?.factions.includes(faction)) { s.taxi.push(id); found.push(id); }
  }
  for (const id of found) log(s, 'info', `New flight path discovered: ${data.taxiNodes[id].name}.`);
  return found;
}
