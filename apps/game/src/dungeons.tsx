// Dungeons: the list of instances, the guild's group board (sign up with a role), runs, and 3D replays.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  dungeonLoot, MAX_TARGETS, nextReset, ROLE_CLASSES, type DungeonDef, type DungeonGroup, type GameData, type GameState, type GuildSnapshot, type Role, type RunEvent,
  type RunResult, type Snapshot,
} from '@idle/sim';
import { game } from './game.js';
import { GroupDiorama } from './groupscene.js';
import { topDrops } from './loot-preview.js';
import { Bar, fmtTime, Icon, ItemIcon, ItemTooltip, withTip } from './ui.js';

type P = { s: GameState; data: GameData; g: GuildSnapshot };
const ROLE_LABEL: Record<Role, string> = { tank: 'Tank', healer: 'Healer', dps: 'Damage' };
const ROLE_ICON: Record<Role, string> = { tank: 'Ability_Defend', healer: 'Spell_Holy_Heal', dps: 'Ability_DualWield' };

export function DungeonsPage({ s, data, g }: P) {
  const [showAll, setShowAll] = useState(false);
  const [watching, setWatching] = useState<number | null>(null);
  const roles = (['tank', 'healer', 'dps'] as Role[]).filter(r => ROLE_CLASSES[r].includes(s.char.cls));
  const me = game.account?.id;
  const dungeons = Object.values(data.dungeons ?? {}).filter(d => !d.raid).sort((a, b) => a.minLevel - b.minLevel)
    .filter(d => showAll || (s.char.level >= d.minLevel - 3 && s.char.level <= d.maxLevel + 3));
  const raids = Object.values(data.dungeons ?? {}).filter(d => d.raid).sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || a.size - b.size);
  const groups = g.groups ?? [];
  const mine = groups.find(x => x.status === 'open' && x.members.some(m => m.accountId === me));
  const busy = s.action?.kind === 'dungeon' ? s.action : null;
  return (
    <>
      <div className="panel-head"><h2>Dungeons</h2><span className="muted">Sign up with a role; empty slots are filled with hirelings when the leader starts.</span></div>
      {busy && (
        <div className="panel">
          <div className="panel-head"><h3>In {data.dungeons[busy.dungeon]?.name}</h3><span className="spacer" />
            <button className="btn" onClick={() => setWatching(busy.run)}>Watch live</button></div>
          <Bar kind="work" value={Date.now() - (busy.until - (groups.find(x => x.run?.id === busy.run)?.run?.ends ?? busy.until) + (groups.find(x => x.run?.id === busy.run)?.run?.started ?? Date.now()))}
            max={Math.max(1, busy.until - (groups.find(x => x.run?.id === busy.run)?.run?.started ?? Date.now()))} label={`back in ${fmtTime(Math.max(0, busy.until - Date.now()))}`} />
        </div>
      )}
      <GroupBoard s={s} data={data} g={g} groups={groups} me={me} roles={roles} watch={setWatching} />
      <RaidsPanel s={s} data={data} g={g} raids={raids} roles={roles} blocked={!!mine || !!busy} me={me} />
      <div className="panel">
        <div className="panel-head"><h3>Instances</h3><span className="spacer" />
          <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show all</label></div>
        <div className="grid">
          {dungeons.map(d => {
            const bosses = d.encounters.filter(e => e.boss).map(e => e.boss!);
            const drops = bosses.flatMap(b => topDrops(data, data.creatures[b]?.loot ?? null, 3)).filter(([i]) => (data.items[i]?.quality ?? 0) >= 3)
              .sort((a, b) => (data.items[b[0]]?.quality ?? 0) - (data.items[a[0]]?.quality ?? 0)).slice(0, 8);
            const tooLow = s.char.level < d.minLevel;
            return (
              <div key={d.id} className="card">
                <div className="title">{d.name}</div>
                <div className="meta">Levels {d.minLevel}-{d.maxLevel} · {d.size} players · {d.encounters.length} pulls{d.zone ? ` · in ${data.zones.find(z => z.id === d.zone)?.name}` : ''}</div>
                <div className="meta">{bosses.map(b => data.creatures[b]?.name).join(', ')}</div>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{drops.map(([i]) => (
                  <span key={i} {...withTip(() => <ItemTooltip item={data.items[i]} data={data} />)}><ItemIcon id={i} data={data} size="sm" /></span>))}</div>
                <div className="btn-row">
                  {roles.map(r => (
                    <button key={r} className="btn secondary small" disabled={tooLow || !!mine || !!busy}
                      title={tooLow ? `Requires level ${d.minLevel}` : mine ? "You're already in a group" : ''}
                      onClick={() => game.groupOp('create', d.id, r)}>
                      <Icon name={ROLE_ICON[r]} size="sm" /> Start a group as {ROLE_LABEL[r]}</button>))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {watching !== null && <ReplayViewer data={data} run={watching} onClose={() => setWatching(null)} />}
    </>
  );
}

const TIER_LABEL = ['', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];

/** Raids: level 60, 20 or 40 players, a lockout per character that resets every few days. */
function RaidsPanel({ s, data, g, raids, roles, blocked, me }: { s: GameState; data: GameData; g: GuildSnapshot; raids: DungeonDef[]; roles: Role[]; blocked: boolean; me?: number }) {
  const [picking, setPicking] = useState<{ dungeon: number; role: Role } | null>(null);
  if (!raids.length) return null;
  const now = game.serverNow;
  return (
    <div className="panel">
      <div className="panel-head"><h3>Raids</h3><span className="muted">Level 60 · entering saves you until the reset (every {raids[0].resetDays ?? 3} days) · set up to {MAX_TARGETS} loot targets</span></div>
      <div className="grid">
        {raids.map(d => {
          const lock = (g.lockouts ?? []).find(l => l.dungeon === d.id && l.accountId === me && l.until > now);
          const saved = (g.lockouts ?? []).filter(l => l.dungeon === d.id && l.until > now).map(l => l.name);
          const bosses = d.encounters.filter(e => e.boss);
          const tooLow = s.char.level < d.minLevel;
          return (
            <div key={d.id} className="card">
              <div className="title">{d.name} <span className="tag">{TIER_LABEL[d.tier ?? 0] ?? ''}</span></div>
              <div className="meta">{d.size} players · {bosses.length} bosses · {d.encounters.length} pulls</div>
              <div className="meta" style={{ color: lock ? 'var(--c-red)' : undefined }}>
                {lock ? `You're saved · resets in ${fmtTime(lock.until - now)}` : `Resets in ${fmtTime(nextReset(d, now) - now)}`}</div>
              {saved.length > 0 && <div className="meta">Saved: {saved.join(', ')}</div>}
              <div className="btn-row">
                {roles.map(r => (
                  <button key={r} className="btn secondary small" disabled={tooLow || blocked || !!lock}
                    title={tooLow ? `Requires level ${d.minLevel}` : lock ? 'Saved to this raid' : blocked ? "You're already in a group" : ''}
                    onClick={() => setPicking({ dungeon: d.id, role: r })}>
                    <Icon name={ROLE_ICON[r]} size="sm" /> Form a raid as {ROLE_LABEL[r]}</button>))}
              </div>
            </div>
          );
        })}
      </div>
      {picking && <TargetPicker data={data} d={data.dungeons[picking.dungeon]} initial={[]} title="Your loot targets"
        onClose={() => setPicking(null)} onSave={t => { game.groupOp('create', picking.dungeon, picking.role, t); setPicking(null); }} />}
    </div>
  );
}

/** Pick up to two items from a dungeon's boss loot: if one drops, it goes to you (or the luckiest of those who target it). */
function TargetPicker({ data, d, initial, title, onSave, onClose }: { data: GameData; d: DungeonDef; initial: number[]; title: string; onSave: (t: number[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<number[]>(initial);
  const [q, setQ] = useState('');
  const loot = useMemo(() => [...dungeonLoot(data, d)], [data, d]);
  const toggle = (i: number) => setSel(x => (x.includes(i) ? x.filter(y => y !== i) : x.length >= MAX_TARGETS ? [...x.slice(1), i] : [...x, i]));
  const match = (i: number) => !q || (data.items[i]?.name ?? '').toLowerCase().includes(q.toLowerCase());
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="panel modal targets" onClick={e => e.stopPropagation()}>
        <div className="panel-head"><h3>{title}</h3><span className="muted">{d.name} · {sel.length}/{MAX_TARGETS}</span></div>
        <input className="input" placeholder="Search items…" value={q} onChange={e => setQ(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
        <div className="target-list">
          {loot.map(([boss, items]) => {
            const shown = items.filter(match);
            if (!shown.length) return null;
            return (
              <div key={boss} className="target-boss">
                <div className="meta">{data.creatures[boss]?.name}</div>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{shown.map(i => (
                  <span key={i} className={`target-item ${sel.includes(i) ? 'on' : ''}`} onClick={() => toggle(i)} {...withTip(() => <ItemTooltip item={data.items[i]} data={data} />)}>
                    <ItemIcon id={i} data={data} size="sm" /></span>))}</div>
              </div>
            );
          })}
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn small" onClick={() => onSave(sel)}>{sel.length ? 'Save targets' : 'No targets'}</button>
          <button className="btn secondary small" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Targets({ data, ids }: { data: GameData; ids?: number[] }) {
  if (!ids?.length) return null;
  return <>{ids.map(i => <span key={i} {...withTip(() => <><ItemTooltip item={data.items[i]} data={data} /><div className="t-muted">Targeted</div></>)}><ItemIcon id={i} data={data} size="sm" /></span>)}</>;
}

function GroupBoard({ s, data, g, groups, me, roles, watch }: { s: GameState; data: GameData; g: GuildSnapshot; groups: DungeonGroup[]; me?: number; roles: Role[]; watch: (run: number) => void }) {
  const [picking, setPicking] = useState<{ group: number; role?: Role } | null>(null);
  const open = groups.filter(x => x.status === 'open'), running = groups.filter(x => x.status === 'running'), done = groups.filter(x => x.status === 'done').slice(0, 8);
  const inAny = open.some(x => x.members.some(m => m.accountId === me));
  const pickGroup = picking ? groups.find(x => x.id === picking.group) : undefined;
  return (
    <div className="panel">
      <div className="panel-head"><h3>Group board</h3></div>
      {!open.length && !running.length && !done.length && <p className="muted" style={{ margin: 0 }}>No groups yet. Start one below.</p>}
      <div className="grid">
        {open.map(grp => {
          const d = data.dungeons[grp.dungeon];
          const isMember = grp.members.some(m => m.accountId === me), isLeader = grp.leaderId === me;
          const free = (d?.size ?? 5) - grp.members.length;
          const saved = d?.raid && (g.lockouts ?? []).some(l => l.dungeon === grp.dungeon && l.accountId === me && l.until > game.serverNow);
          const count = (r: Role) => grp.members.filter(m => m.role === r).length;
          return (
            <div key={grp.id} className={`card ${isMember ? 'current' : ''}`}>
              <div className="title">{d?.name}{d?.raid && <span className="tag">Raid</span>}</div>
              <div className="meta">Forming · led by {grp.leader}{d && d.size > 5 ? ` · ${grp.members.length}/${d.size} · ${count('tank')} tanks, ${count('healer')} healers, ${count('dps')} damage` : ''}</div>
              <div className={d && d.size > 5 ? 'roster-compact' : ''}>
                {grp.members.map(m => <div key={m.accountId} className="row" style={{ gap: 6, fontSize: 13 }}><Icon name={ROLE_ICON[m.role]} size="sm" /> {m.name} <span className="muted">{m.level} {data.classes.find(c => c.id === m.cls)?.name}</span> <Targets data={data} ids={m.targets} /></div>)}
              </div>
              {free > 0 && <div className="meta">{free} open slot{free > 1 ? 's' : ''} (hirelings fill them at the start)</div>}
              <div className="btn-row">
                {!isMember && !inAny && s.action?.kind !== 'dungeon' && !saved && roles.map(r => (
                  <button key={r} className="btn secondary small" disabled={s.char.level < (d?.minLevel ?? 1)}
                    onClick={() => (d?.raid ? setPicking({ group: grp.id, role: r }) : game.groupOp('join', grp.id, r))}>Join as {ROLE_LABEL[r]}</button>))}
                {saved && !isMember && <span className="muted" style={{ fontSize: 12 }}>You're saved to this raid.</span>}
                {isMember && <button className="btn secondary small" onClick={() => setPicking({ group: grp.id })}>Loot targets</button>}
                {isLeader && <button className="btn small" onClick={() => game.groupOp('start', grp.id)}>Start the run</button>}
                {isMember && <button className="btn secondary small" onClick={() => game.groupOp('leave', grp.id)}>{isLeader ? 'Disband' : 'Leave'}</button>}
              </div>
            </div>
          );
        })}
        {[...running, ...done].map(grp => {
          const d = data.dungeons[grp.dungeon], r = grp.run;
          const over = r && r.ends <= Date.now();
          return (
            <div key={grp.id} className="card">
              <div className="title" style={{ color: over ? (r!.cleared ? 'var(--c-green)' : 'var(--c-red)') : undefined }}>{d?.name}</div>
              <div className="meta">{!r ? '' : !over ? `In progress · ${fmtTime(Math.max(0, r.ends - Date.now()))} left` : r.cleared ? 'Cleared' : `Wiped after ${r.progress} of ${r.total} pulls`}</div>
              <div className="meta">{r?.members.map(m => `${m.name}${m.hireling ? '' : ''}`).join(', ')}</div>
              {over && r!.loot.length > 0 && <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{r!.loot.map((l, i) => (
                <span key={i} {...withTip(() => <><ItemTooltip item={data.items[l.item]} data={data} /><div className="t-muted">{l.winner ? `Won by ${l.winner}` : 'Nobody wanted it'}</div></>)}>
                  <ItemIcon id={l.item} data={data} size="sm" /></span>))}</div>}
              {r && <div className="btn-row"><button className="btn secondary small" onClick={() => watch(r.id)}>{over ? 'Watch replay' : 'Watch live'}</button></div>}
            </div>
          );
        })}
      </div>
      {picking && pickGroup && data.dungeons[pickGroup.dungeon] && (
        <TargetPicker data={data} d={data.dungeons[pickGroup.dungeon]} title="Your loot targets"
          initial={pickGroup.members.find(m => m.accountId === me)?.targets ?? []} onClose={() => setPicking(null)}
          onSave={t => { if (picking.role) game.groupOp('join', picking.group, picking.role, t); else game.groupTargets(picking.group, t); setPicking(null); }} />)}
    </div>
  );
}

// ---------------------------------------------------------------- replay

interface Floater { id: number; x: number; y: number; text: string; cls: string }
const SPEEDS = [1, 4, 16];

export function ReplayViewer({ data, run, onClose }: { data: GameData; run: number; onClose: () => void }) {
  const [rep, setRep] = useState<{ run: RunResult; snapshots: Snapshot[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { game.replay(run).then(r => (r ? setRep(r) : setFailed(true))); }, [run]);
  // Let the guild see who's watching (and watch together while the run is live).
  useEffect(() => { game.watch(run); return () => game.watch(null); }, [run]);
  const summary = game.guild?.groups.find(x => x.run?.id === run)?.run;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="panel modal replay" onClick={e => e.stopPropagation()}>
        {!rep ? <p className="muted">{failed ? "Couldn't load the replay." : 'Loading the replay…'}</p> : <ReplayPlayer data={data} rep={rep} onClose={onClose} started={summary?.started ?? 0} ends={summary?.ends ?? 0} watching={summary?.watching ?? []} />}
      </div>
    </div>
  );
}

function ReplayPlayer({ data, rep, onClose, started, ends, watching }: {
  data: GameData; rep: { run: RunResult; snapshots: Snapshot[] }; onClose: () => void; started: number; ends: number; watching: string[];
}) {
  // Live: the run is still going, so everyone sees the same moment (the replay locked to the real clock).
  const [live, setLive] = useState(() => !!started && game.serverNow < ends);
  const liveRef = useRef(live);
  liveRef.current = live;
  const host = useRef<HTMLDivElement>(null);
  const dio = useRef<GroupDiorama | null>(null);
  const { run, snapshots } = rep;
  const d = data.dungeons[run.dungeon];
  const [speed, setSpeed] = useState(4);
  const [t, setT] = useState(0);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const state = useRef({ cursor: 0, t: 0, hp: snapshots.map(s => s.maxHp), mobs: new Map<number, { id: number; hp: number; max: number }>(), pull: -1 });
  const [, force] = useState(0);
  const events = run.events;
  // Raids put at most ten members on stage (the tanks, a few healers, the rest damage); all are in the frames.
  const slot = useMemo(() => {
    if (snapshots.length <= 10) return snapshots.map((_, i) => i);
    const by = (r: Role) => snapshots.map((x, i) => (x.role === r ? i : -1)).filter(i => i >= 0);
    const pick = [...by('tank').slice(0, 2), ...by('healer').slice(0, 3), ...by('dps').slice(0, 5)];
    return snapshots.map((_, i) => pick.indexOf(i));
  }, [snapshots]);
  const P = (i: number) => slot[i] ?? -1;
  const mobName = (uid: number) => data.creatures[state.current.mobs.get(uid)?.id ?? 0]?.name ?? 'Enemy';
  const spellName = (id?: number) => (id ? Object.values(data.creatures).flatMap(c => c.abilities ?? []).find(a => a.spell === id)?.name : undefined);

  useEffect(() => {
    const g = new GroupDiorama(host.current!);
    dio.current = g;
    g.setParty(snapshots.filter((_, i) => slot[i] >= 0).sort((a, b) => slot[snapshots.indexOf(a)] - slot[snapshots.indexOf(b)]).map(s => ({ look: s.look ? { race: s.race, ...s.look } : { race: s.race, sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 }, gear: s.gear })));
    return () => { g.dispose(); dio.current = null; };
  }, []);

  // Playback: advance the cursor through the events at the chosen speed; long quiet stretches are skipped.
  useEffect(() => {
    let raf = 0, last = performance.now();
    const fid = { n: 0 };
    const float = (who: number, mob: boolean, text: string, cls: string) => {
      const p = dio.current?.screenPos(who, mob);
      if (!p) return;
      const f = { id: ++fid.n + Math.random(), x: p.x + (Math.random() - 0.5) * 30, y: p.y, text, cls };
      setFloaters(fs => [...fs.slice(-16), f]);
      setTimeout(() => setFloaters(fs => fs.filter(x => x.id !== f.id)), 1100);
    };
    const step = (now: number) => {
      const st = state.current;
      const dt = Math.min(250, now - last); last = now;
      if (liveRef.current && game.serverNow >= ends) setLive(false);
      if (st.cursor < events.length) {
        const lines: string[] = [];
        if (liveRef.current) {
          const target = game.serverNow - started;
          // Joining late: catch up without replaying minutes of animation, then show the latest pull.
          if (target - st.t > 3000) {
            let lastPull: Extract<RunEvent, { k: 'pull' }> | null = null;
            while (st.cursor < events.length && events[st.cursor].t <= target - 1500) {
              const e = events[st.cursor++];
              apply(e, st, [], () => {}, true);
              if (e.k === 'pull') lastPull = e;
            }
            if (lastPull) dio.current?.setMobs(lastPull.mobs.filter(m => (st.mobs.get(m.uid)?.hp ?? 0) > 0).map(m => ({ uid: m.uid, displayIds: data.creatures[m.id]?.displayIds ?? [] })));
          }
          st.t = target;
        } else {
          const nextT = events[st.cursor].t;
          st.t = nextT - st.t > 5000 ? nextT : st.t + dt * speed; // walking and resting fly by
        }
        while (st.cursor < events.length && events[st.cursor].t <= st.t) {
          const e = events[st.cursor++];
          apply(e, st, lines, float);
        }
        if (lines.length) setLog(l => [...l, ...lines].slice(-60));
        setT(st.t);
      }
      raf = requestAnimationFrame(step);
    };
    const apply = (e: RunEvent, st: typeof state.current, lines: string[], fl: typeof float, quiet = false) => {
      const g = quiet ? null : dio.current;
      switch (e.k) {
        case 'pull':
          st.pull = e.enc;
          st.mobs = new Map(e.mobs.map(m => [m.uid, { id: m.id, hp: m.hp, max: m.hp }]));
          st.hp = snapshots.map(s => s.maxHp);
          g?.reviveParty();
          g?.setMobs(e.mobs.map(m => ({ uid: m.uid, displayIds: data.creatures[m.id]?.displayIds ?? [] })));
          lines.push(`— Pull ${e.enc + 1}: ${e.mobs.map(m => data.creatures[m.id]?.name).join(', ')}`);
          break;
        case 'hit':
          if (e.mob) {
            st.hp[e.dst] = Math.max(0, st.hp[e.dst] - e.amt);
            if (e.src >= 0) g?.attack(e.src, true);
            g?.wound(P(e.dst), false);
            fl(P(e.dst), false, String(e.amt), 'mob');
          } else {
            const m = st.mobs.get(e.dst);
            if (m) m.hp = Math.max(0, m.hp - e.amt);
            g?.attack(P(e.src), false);
            fl(e.dst, true, String(e.amt), `player ${e.crit ? 'crit' : ''}`);
          }
          break;
        case 'heal':
          st.hp[e.dst] = Math.min(snapshots[e.dst].maxHp, st.hp[e.dst] + e.amt);
          g?.cast(P(e.src), false);
          fl(P(e.dst), false, `+${e.amt}`, 'heal');
          break;
        case 'cast':
          g?.cast(e.mob, true);
          lines.push(`${mobName(e.mob)} casts ${spellName(e.spell) ?? 'a spell'}${e.dst === 'all' ? ' on everyone' : e.dst >= 0 ? ` on ${snapshots[e.dst]?.name}` : ''}.`);
          break;
        case 'die':
          g?.die(e.mob ? e.who : P(e.who), e.mob);
          lines.push(e.mob ? `${mobName(e.who)} dies.` : `${snapshots[e.who]?.name} dies.`);
          break;
        case 'clear': lines.push(`Pull ${e.enc + 1} cleared.`); break;
        case 'wipe': lines.push(`The group wiped on pull ${e.enc + 1}.`); break;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [speed, live]);

  const st = state.current;
  const total = events.length ? events[events.length - 1].t : 1;
  const restart = () => {
    state.current = { cursor: 0, t: 0, hp: snapshots.map(s => s.maxHp), mobs: new Map(), pull: -1 };
    setLog([]);
    dio.current?.reviveParty();
    dio.current?.setMobs([]);
    setLive(false);
  };
  const skip = () => {
    const next = events.findIndex((e, i) => i > st.cursor && e.k === 'pull');
    if (next > 0) { st.t = events[next].t - 1; force(x => x + 1); }
  };
  const loot = useMemo(() => run.loot.filter(l => l.winner !== null), [run]);
  return (
    <>
      <div className="panel-head"><h2>{d?.name}</h2><span className="muted">{st.cursor >= events.length ? (run.cleared ? 'Cleared' : `Wiped after ${run.progress} of ${d?.encounters.length} pulls`) : `Pull ${st.pull + 1} of ${d?.encounters.length}`} · {fmtTime(run.durationMs)}</span><span className="spacer" />
        {live && <span className="tag live">● LIVE</span>}
        {watching.length > 0 && <span className="muted" style={{ fontSize: 12 }}>Watching: {watching.join(', ')}</span>}
        {live ? <button className="chip" onClick={restart}>From the start</button>
          : <>
            {SPEEDS.map(x => <button key={x} className={`chip ${speed === x ? 'on' : ''}`} onClick={() => setSpeed(x)}>{x}x</button>)}
            <button className="chip" onClick={skip}>Next pull</button>
            {!!started && game.serverNow < ends && <button className="chip" onClick={() => { restart(); setLive(true); }}>Watch live</button>}
          </>}
        <button className="btn secondary small" onClick={onClose}>Close</button></div>
      <div className="diorama replay-scene" ref={host}>
        <div className="hud replay-hud">
          {snapshots.length > 10 ? (
            <div className="raid-frames">{snapshots.map((sn, i) => (
              <div key={i} className={`raid-cell role-${sn.role} ${st.hp[i] <= 0 ? 'dead' : ''}`} title={sn.name}>
                <div className="fill" style={{ width: `${Math.max(0, Math.min(100, (st.hp[i] / sn.maxHp) * 100))}%` }} />
                <span>{sn.name.slice(0, 8)}</span>
              </div>))}</div>
          ) : (
          <div>{snapshots.map((sn, i) => (
            <div key={i} className="unitframe small">
              <div className="uname"><span>{sn.name}</span><span className="muted">{sn.role === 'tank' ? 'T' : sn.role === 'healer' ? 'H' : 'D'}</span></div>
              <Bar kind="hp" thin value={st.hp[i]} max={sn.maxHp} />
            </div>))}</div>)}
          <div>{[...st.mobs].map(([uid, m]) => (
            <div key={uid} className="unitframe small">
              <div className="uname"><span>{data.creatures[m.id]?.name}</span></div>
              <Bar kind="enemy" thin value={m.hp} max={m.max} />
            </div>))}</div>
        </div>
        <div className="floaters">{floaters.map(f => <div key={f.id} className={`floater ${f.cls}`} style={{ left: f.x, top: f.y }}>{f.text}</div>)}</div>
      </div>
      <Bar kind="xp" thin value={t} max={total} />
      <div className="replay-log">{log.slice(-8).map((l, i) => <div key={i}>{l}</div>)}</div>
      {st.cursor >= events.length && loot.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{loot.map((l, i) => (
          <span key={i} {...withTip(() => <><ItemTooltip item={data.items[l.item]} data={data} /><div className="t-muted">Won by {snapshots[l.winner!]?.name}</div></>)}>
            <ItemIcon id={l.item} data={data} size="sm" /></span>))}</div>
      )}
    </>
  );
}
