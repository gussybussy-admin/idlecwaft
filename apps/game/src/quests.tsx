// Quest log, quests on offer in the current zone, and reputation standings.
import { useMemo, useState } from 'react';
import {
  availableQuests, canQuestTask, questBlocked, questComplete, questObjectives, questXp, REP_MIN, REP_RANKS, repRank, standing,
  type GameData, type GameState, type LootRef, type QuestDef,
} from '@idle/sim';
import { game } from './game.js';
import { ActionScene, WorkBar } from './pages.js';
import { Bar, fmtTime, ItemIcon, ItemTooltip, Money, useSearch, withTip } from './ui.js';

type P = { s: GameState; data: GameData };

/** Creatures in a zone whose loot (through references) can contain an item. */
function droppers(data: GameData, zone: number, item: number): number[] {
  const has = (ref: LootRef | null | undefined, seen = new Set<string>()): boolean => {
    const t = ref ? data.loot[ref] : undefined;
    if (!t || seen.has(ref!)) return false;
    seen.add(ref!);
    return [...t.entries, ...t.groups.flat()].some(e => ('item' in e ? e.item === item : has(e.ref, seen)));
  };
  return (data.zones.find(z => z.id === zone)?.creatures ?? []).map(c => c.id).filter(id => has(data.creatures[id]?.loot));
}

const zoneName = (data: GameData, id: number) => data.zones.find(z => z.id === id)?.name ?? 'somewhere';

function Rewards({ q, s, data, choice, setChoice }: P & { q: QuestDef; choice?: number; setChoice?: (i: number) => void }) {
  const xp = s.char.level < data.maxLevel ? questXp(q, s.char.level) : 0;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {xp > 0 && <span className="tag">{xp} XP</span>}
      {(q.money > 0 || (!xp && q.moneyMax > 0)) && <span className="tag"><Money copper={q.money + (xp ? 0 : q.moneyMax)} /></span>}
      {q.rewItems.map(([i, n]) => <span key={i} {...withTip(() => <ItemTooltip item={data.items[i]} data={data} />)}><ItemIcon id={i} data={data} count={n} size="sm" /></span>)}
      {q.choice.length > 0 && <span className="faint" style={{ fontSize: 12 }}>Choose:</span>}
      {q.choice.map(([i, n]) => (
        <span key={i} className={`choice-item ${choice === i ? 'on' : ''}`} onClick={() => setChoice?.(i)} {...withTip(() => <ItemTooltip item={data.items[i]} data={data} />)}>
          <ItemIcon id={i} data={data} count={n} size="sm" /></span>))}
      {q.rep.filter(([f]) => data.factions[f]).map(([f, v]) => <span key={f} className="tag">{data.factions[f].name} {v > 0 ? '+' : ''}{v}</span>)}
    </div>
  );
}

function ActiveQuest({ s, data, id }: P & { id: number }) {
  const q = data.quests[id];
  const [choice, setChoice] = useState<number | undefined>(undefined);
  if (!q) return null;
  const objs = questObjectives(s, data, id);
  const done = questComplete(s, data, id);
  const tasking = s.action?.kind === 'quest' && s.action.quest === id;
  const taskErr = q.task && !s.quests[id].task ? canQuestTask(s, data, id) : null;
  // Something to fight for: the first unfinished kill, or a creature here that drops a needed item.
  const target = q.kills.find(([c], i) => (s.quests[id].kills[i] ?? 0) < q.kills[i][1])?.[0]
    ?? q.items.filter(([it, n]) => (s.inventory[it] ?? 0) < n && !q.task?.grants.some(([g]) => g === it)).map(([it]) => droppers(data, s.zone, it)[0]).find(Boolean);
  const fighting = s.action?.kind === 'fight' && s.action.creature === target;
  return (
    <div className={`card ${done ? 'current' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="title" style={{ color: done ? 'var(--gold)' : undefined }}>[{q.level}] {q.name}{done ? ' (complete)' : ''}</div>
      </div>
      <div className="meta">{q.objectives}</div>
      {objs.map((o, i) => (
        <div key={i} className="row" style={{ gap: 8, fontSize: 13 }}>
          <span style={{ flex: 1 }} className={o.have >= o.need ? 'c-green' : ''}>{o.label}</span><span className="muted">{o.have}/{o.need}</span>
        </div>
      ))}
      {tasking && <WorkBar s={s} />}
      <Rewards q={q} s={s} data={data} choice={choice} setChoice={setChoice} />
      <div className="meta">{done ? `Hand in to ${q.ender} in ${zoneName(data, q.endZone)}` : `From ${q.giver}`}</div>
      <div className="btn-row">
        {done && <button className="btn" disabled={s.zone !== q.endZone || (q.choice.length > 0 && choice === undefined)}
          title={s.zone !== q.endZone ? `Travel to ${zoneName(data, q.endZone)}` : q.choice.length && choice === undefined ? 'Pick a reward' : ''}
          onClick={() => game.command({ name: 'turnInQuest', quest: id, ...(choice ? { choice } : {}) })}>Hand in</button>}
        {!done && q.task && !s.quests[id].task && (tasking
          ? <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>
          : <button className="btn" disabled={!!taskErr} title={taskErr ?? ''} onClick={() => game.command({ name: 'start', action: { kind: 'quest', quest: id } })}>
            {q.task.label.length > 34 ? 'Do the task' : q.task.label} ({fmtTime(q.task.ms)})</button>)}
        {!done && target && !fighting && <button className="btn secondary" onClick={() => game.command({ name: 'start', action: { kind: 'fight', creature: target } })}>
          Hunt {data.creatures[target]?.name}</button>}
        <button className="btn secondary small" onClick={() => confirm(`Abandon ${q.name}?`) && game.command({ name: 'abandonQuest', quest: id })}>Abandon</button>
      </div>
      {!done && taskErr && <div className="faint" style={{ fontSize: 12 }}>{taskErr}</div>}
    </div>
  );
}

export function QuestsPage({ s, data }: P) {
  const log = Object.keys(s.quests).map(Number).sort((a, b) => Number(questComplete(s, data, b)) - Number(questComplete(s, data, a)) || (data.quests[a]?.level ?? 0) - (data.quests[b]?.level ?? 0));
  const here = availableQuests(s, data);
  const [showLow, setShowLow] = useState(false);
  const { box, match } = useSearch('Search quests');
  const shown = here.filter(q => (showLow || q.level >= s.char.level - 6) && match(q.name, q.objectives, q.giver));
  const logShown = log.filter(id => match(data.quests[id]?.name, data.quests[id]?.objectives));
  // Where else quests wait for this character, near their level.
  const elsewhere = useMemo(() => {
    const m = new Map<number, number>();
    for (const q of Object.values(data.quests)) {
      if (q.zone === s.zone || Math.abs(q.level - s.char.level) > 4 || questBlocked(s, data, q)) continue;
      m.set(q.zone, (m.get(q.zone) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [data, s.zone, s.char.level, s.questsDone.length, Object.keys(s.quests).length]);
  return (
    <>
      <div className="panel-head"><h2>Quests</h2><span className="muted">{log.length} / 20 in your log · {s.questsDone.length} completed</span></div>
      <ActionScene s={s} data={data} hint="Accept a quest, then hunt or run its task" />
      <div className="panel">
        <div className="panel-head"><h3>Quest log</h3><span className="spacer" />{box}</div>
        {log.length ? <div className="grid">{logShown.map(id => <ActiveQuest key={id} s={s} data={data} id={id} />)}</div>
          : <p className="muted">Your quest log is empty. Pick something up below.</p>}
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Available in {zoneName(data, s.zone)}</h3><span className="spacer" />
          <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={showLow} onChange={e => setShowLow(e.target.checked)} /> Show low-level quests</label></div>
        <div className="grid">
          {shown.map(q => (
            <div key={q.id} className="card">
              <div className={`title ${q.level >= s.char.level + 3 ? 'c-orange' : q.level <= s.char.level - 6 ? 'c-grey' : 'c-yellow'}`}>[{q.level}] {q.name}</div>
              <div className="meta">{q.giver}{q.endZone !== q.zone ? ` · ends in ${zoneName(data, q.endZone)}` : ''}</div>
              <div className="meta">{q.objectives}</div>
              <Rewards q={q} s={s} data={data} />
              <div className="btn-row"><button className="btn" onClick={() => game.command({ name: 'acceptQuest', quest: q.id })}>Accept</button></div>
            </div>
          ))}
          {!shown.length && <span className="muted">No quests for you here{here.length ? ' at your level' : ''}.</span>}
        </div>
        {elsewhere.length > 0 && <p className="meta" style={{ marginTop: 12 }}>Quests near your level elsewhere: {elsewhere.map(([z, n]) => `${zoneName(data, z)} (${n})`).join(' · ')}</p>}
      </div>
    </>
  );
}

export function ReputationPage({ s, data }: P) {
  const known = Object.values(data.factions)
    .filter(f => !f.name.includes(' - ') && (s.rep[f.id] !== undefined || (f.base[s.char.race] ?? 0) > 0)) // ' - ': hidden profession specializations
    .sort((a, b) => standing(s, data, b.id) - standing(s, data, a.id));
  return (
    <>
      <div className="panel-head"><h2>Reputation</h2></div>
      <div className="panel">
        {known.map(f => {
          const v = standing(s, data, f.id), r = repRank(v);
          const lo = REP_MIN[r], hi = r < 7 ? REP_MIN[r + 1] : 43000;
          return (
            <div key={f.id} style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><span>{f.name}</span><span className={`rep-${r}`}>{REP_RANKS[r]}</span></div>
              <Bar kind={`rep rep-${r}`} value={v - lo} max={hi - lo} label={`${v - lo} / ${hi - lo}`} thin />
            </div>
          );
        })}
        {!known.length && <p className="muted">No reputations yet. Quests and some enemies change how factions see you.</p>}
      </div>
    </>
  );
}
