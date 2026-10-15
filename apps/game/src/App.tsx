import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { playerStats, type GameData, type GameState, type Profession, type Summary } from '@idle/sim';
import { game } from './game.js';
import { GuildPage } from './guild.js';
import { TravelPage } from './travel.js';
import { BagsPanel, CharacterPage, CombatPage, CookingPage, FishingPage, GatherPage, LogPage, SKILL_ICON, TownPage } from './pages.js';
import { Bar, fmtTime, Icon, ItemIcon, Money, TooltipHost } from './ui.js';
import { randomLook, type Look } from './character.js';
import { Diorama } from './diorama.js';

/** A small turntable of the character being created, using the same diorama as combat. */
function CharacterPreview({ look }: { look: Look }) {
  const host = useRef<HTMLDivElement>(null);
  const dio = useRef<Diorama | null>(null);
  useEffect(() => { dio.current = new Diorama(host.current!, { preview: true }); return () => dio.current?.dispose(); }, []);
  useEffect(() => { dio.current?.setPlayer(look); }, [look]);
  return <div className="diorama" ref={host} style={{ height: 260, marginTop: 10 }} />;
}

type Page = 'combat' | Profession | 'character' | 'bags' | 'town' | 'travel' | 'guild' | 'log';

export function App() {
  useSyncExternalStore(game.subscribe, game.getVersion);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => { try { return (localStorage.getItem('idlecwaft.page') as Page) || 'combat'; } catch { return 'combat'; } });
  useEffect(() => { game.start().catch(e => setError(String(e.message ?? e))); return () => game.dispose(); }, []);
  useEffect(() => { try { localStorage.setItem('idlecwaft.page', page); } catch { /* ignore */ } }, [page]);

  if (error) return <div className="create"><h2>Can't start</h2><p className="muted">{error}</p><button className="btn" onClick={() => game.logout()}>Back to login</button></div>;
  if (game.phase === 'login') return <><Login /><Toast /></>;
  if (game.phase === 'connecting' || !game.data) return <div className="create"><h2>Connecting to {game.serverUrl}…</h2></div>;
  if (game.phase === 'create') return <><CreateCharacter data={game.data} /><Toast /></>;
  const s = game.state, data = game.data, g = game.guild;
  if (!s || !g) return <div className="create"><h2>Entering the world…</h2></div>;

  return (
    <div className="app">
      <Sidebar s={s} data={data} page={page} setPage={setPage} />
      <main className="main"><div className="main-inner">
        {page === 'guild' && <GuildPage s={s} data={data} g={g} />}
        {page === 'combat' && <CombatPage s={s} data={data} />}
        {(page === 'mining' || page === 'herbalism') && <GatherPage s={s} data={data} skill={page} />}
        {page === 'fishing' && <FishingPage s={s} data={data} />}
        {page === 'cooking' && <CookingPage s={s} data={data} />}
        {page === 'character' && <CharacterPage s={s} data={data} />}
        {page === 'bags' && <BagsPanel s={s} data={data} />}
        {page === 'town' && <TownPage s={s} data={data} />}
        {page === 'log' && <LogPage s={s} data={data} />}
        {page === 'travel' && <TravelPage s={s} data={data} />}
      </div></main>
      {game.away && <AwayReport sum={game.away} data={data} />}
      <Toast />
      <TooltipHost />
    </div>
  );
}

const Toast = () => game.toast ? <div className="toast" role="status">{game.toast}</div> : null;

function Login() {
  const [server, setServer] = useState(game.serverUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (kind: 'login' | 'register') => {
    setBusy(true); setErr(null);
    const e = await game.auth(kind, server, username, password);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <div className="create" style={{ maxWidth: 460 }}>
      <h1 style={{ fontSize: 40 }}>World of Idlecraft</h1>
      <form className="panel" onSubmit={e => { e.preventDefault(); go('login'); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="muted" htmlFor="srv">Guild server</label>
        <input id="srv" className="text" value={server} onChange={e => setServer(e.target.value)} placeholder="http://100.x.y.z:7420" />
        <label className="muted" htmlFor="usr">Username</label>
        <input id="usr" className="text" value={username} autoComplete="username" onChange={e => setUsername(e.target.value)} />
        <label className="muted" htmlFor="pw">Password</label>
        <input id="pw" className="text" type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} />
        {err && <div className="c-red" style={{ fontSize: 13 }}>{err}</div>}
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="btn" type="submit" disabled={busy || !username || !password}>Log in</button>
          <button className="btn secondary" type="button" disabled={busy || !username || !password} onClick={() => go('register')}>Create account</button>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>New accounts join the guild automatically. One character per account.</p>
      </form>
    </div>
  );
}

function Sidebar({ s, data, page, setPage }: { s: GameState; data: GameData; page: Page; setPage: (p: Page) => void }) {
  const st = playerStats(s, data);
  const toNext = data.xpToNext[s.char.level] ?? 0;
  const cls = data.classes.find(c => c.id === s.char.cls)?.name;
  const actionPage: Page | null = !s.action ? null : s.action.kind === 'fight' ? 'combat' : s.action.kind === 'travel' ? 'travel' : s.action.kind === 'fish' ? 'fishing'
    : s.action.kind === 'cook' ? 'cooking' : data.nodes[s.action.node]?.skill ?? null;
  const item = (p: Page, icon: string, label: string, right?: string) => (
    <button className={`${page === p ? 'on' : ''} ${actionPage === p ? 'active-action' : ''}`} onClick={() => setPage(p)}>
      <Icon name={icon} size="sm" /> {label} {right !== undefined && <span className="lvl">{right}</span>}
    </button>
  );
  const skill = (p: Profession) => item(p, SKILL_ICON[p], p[0].toUpperCase() + p.slice(1), s.skills[p].max ? `${s.skills[p].level}/${s.skills[p].max}` : '—');
  return (
    <aside className="sidebar">
      <div className="charcard">
        <div className="name">{s.char.name}</div>
        <div className="sub">Level {s.char.level} {cls} · {data.zones.find(z => z.id === s.zone)?.name}</div>
        <Bar kind="hp" value={s.char.hp} max={st.maxHp} label={`${Math.floor(s.char.hp)} / ${st.maxHp}`} />
        {s.char.level < data.maxLevel && <Bar kind="xp" value={s.char.xp} max={toNext} label={`${s.char.xp} / ${toNext} XP`} />}
        <Money copper={s.gold} />
        <ActivityLine s={s} data={data} />
        <div className={`conn ${game.connected ? '' : 'off'}`}>{game.connected ? `<${game.guild?.name}> · ${game.guild?.roster.filter(r => r.online).length} online` : 'Reconnecting…'}</div>
      </div>
      <nav className="nav">
        <div className="group">Guild</div>
        <button className={page === 'guild' ? 'on' : ''} onClick={() => setPage('guild')}>
          <Icon name="INV_Misc_Note_01" size="sm" /> {game.guild?.name ?? 'Guild'}
          {game.unreadChat > 0 && page !== 'guild' && <span className="badge">{game.unreadChat}</span>}
        </button>
        <div className="group">Adventure</div>
        {item('combat', 'Ability_Warrior_OffensiveStance', 'Combat', String(s.char.level))}
        <div className="group">Gathering</div>
        {skill('mining')}{skill('herbalism')}{skill('fishing')}
        <div className="group">Production</div>
        {skill('cooking')}
        <div className="group">Character</div>
        {item('character', 'INV_Chest_Chain', 'Equipment')}
        {item('bags', 'INV_Misc_Bag_08', 'Bags', String(Object.keys(s.inventory).length))}
        {item('travel', 'INV_Misc_Map_01', 'Travel')}
        {item('town', 'INV_Misc_Bag_10', 'Trainers & Vendors')}
        {item('log', 'INV_Misc_Note_01', 'Log & Settings')}
      </nav>
    </aside>
  );
}

function ActivityLine({ s, data }: { s: GameState; data: GameData }) {
  const a = s.action;
  const text = !a ? 'Idle'
    : a.kind === 'fight' ? `Fighting ${data.creatures[a.creature]?.name}`
    : a.kind === 'gather' ? `${data.nodes[a.node]?.skill === 'mining' ? 'Mining' : 'Gathering'} ${data.nodes[a.node]?.name}`
    : a.kind === 'travel' ? `Travelling to ${data.zones.find(z => z.id === a.to)?.name}`
    : a.kind === 'fish' ? 'Fishing' : `Cooking ${data.recipes[a.recipe]?.name}`;
  return <div className="sub" style={{ color: a ? 'var(--gold-soft)' : undefined }}>{text}</div>;
}

function AwayReport({ sum, data }: { sum: Summary; data: GameData }) {
  const items = Object.entries(sum.items).map(([i, n]) => [Number(i), n] as [number, number]).filter(([i]) => data.items[i])
    .sort((a, b) => data.items[b[0]].quality - data.items[a[0]].quality || b[1] - a[1]);
  const skills = Object.entries(sum.skillups);
  return (
    <div className="modal-back" onClick={() => game.dismissAway()}>
      <div className="panel modal" onClick={e => e.stopPropagation()}>
        <div className="panel-head"><h2>While you were away</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>{fmtTime(sum.ms)} of progress{sum.ms >= 24 * 3600_000 ? ' (the 24 hour maximum)' : ''}.</p>
        <div className="stats" style={{ marginBottom: 12 }}>
          {sum.kills > 0 && <><span className="k">Kills</span><span className="v">{sum.kills}</span></>}
          {sum.xp > 0 && <><span className="k">Experience</span><span className="v">{sum.xp.toLocaleString()}</span></>}
          {sum.levels > 0 && <><span className="k">Levels gained</span><span className="v" style={{ color: 'var(--gold)' }}>+{sum.levels}</span></>}
          {sum.gold > 0 && <><span className="k">Money looted</span><span className="v"><Money copper={sum.gold} /></span></>}
          {skills.map(([k, n]) => <span key={k} style={{ display: 'contents' }}><span className="k">{k[0].toUpperCase() + k.slice(1)}</span><span className="v" style={{ color: '#6fa8ff' }}>+{n}</span></span>)}
          {sum.deaths > 0 && <><span className="k">Deaths</span><span className="v" style={{ color: '#ff5555' }}>{sum.deaths}</span></>}
        </div>
        {items.length > 0 && <div className="bag" style={{ marginBottom: 12 }}>{items.map(([i, n]) => <div key={i} className="slot"><ItemIcon id={i} data={data} count={n} /></div>)}</div>}
        <button className="btn" onClick={() => game.dismissAway()}>Continue</button>
      </div>
    </div>
  );
}


function CreateCharacter({ data }: { data: GameData }) {
  const CLASS_COMBOS = data.raceClasses;
  const [race, setRace] = useState(1);
  const [cls, setCls] = useState(1);
  const [sex, setSex] = useState(0);
  const [name, setName] = useState('');
  const [look, setLook] = useState<Look | null>(null);
  useEffect(() => { randomLook(race, sex).then(setLook); }, [race, sex]);
  const classes = data.classes.filter(c => CLASS_COMBOS[race]?.includes(c.id));
  const valid = /^[A-Za-z]{2,12}$/.test(name) && classes.some(c => c.id === cls);
  return (
    <div className="create">
      <h1 style={{ fontSize: 40 }}>World of Idlecraft</h1>
      <p className="muted" style={{ margin: 0 }}>Create your character. Elwynn Forest awaits; the rest of Azeroth comes later.</p>
      <div className="panel">
        <h3>Race</h3>
        {(['alliance', 'horde'] as const).map(side => (<div key={side}><div className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8 }}>{side}</div><div className="choices" style={{ marginTop: 4 }}>{data.races.filter(r => r.faction === side).map(r => (
          <button key={r.id} className={`choice ${race === r.id ? 'on' : ''}`} onClick={() => { setRace(r.id); if (!CLASS_COMBOS[r.id]?.includes(cls)) setCls(CLASS_COMBOS[r.id][0]); }}>{r.name}</button>))}</div></div>))}
        <h3 style={{ marginTop: 16 }}>Class</h3>
        <div className="choices" style={{ marginTop: 8 }}>{classes.map(c => (
          <button key={c.id} className={`choice ${cls === c.id ? 'on' : ''}`} onClick={() => setCls(c.id)}>{c.name}</button>))}</div>
        <p className="faint" style={{ fontSize: 12 }}>Every class fights with weapon attacks for now; class spells and talents arrive in a later phase.</p>
        <h3 style={{ marginTop: 16 }}>Appearance</h3>
        <div className="choices" style={{ marginTop: 8 }}>
          <button className={`choice ${sex === 0 ? 'on' : ''}`} onClick={() => setSex(0)}>Male</button>
          <button className={`choice ${sex === 1 ? 'on' : ''}`} onClick={() => setSex(1)}>Female</button>
          <button className="choice" onClick={() => randomLook(race, sex).then(setLook)}>Randomize look</button>
        </div>
        {look && <CharacterPreview look={look} />}
        <h3 style={{ marginTop: 16 }}>Name</h3>
        <input className="text" style={{ marginTop: 8 }} maxLength={12} value={name} onChange={e => setName(e.target.value)} placeholder="2-12 letters" />
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={!valid} onClick={() => game.createCharacter(name, race, cls,
            look ? { sex: look.sex, skin: look.skin, face: look.face, hairStyle: look.hairStyle, hairColor: look.hairColor, facialHair: look.facialHair } : undefined)}>Enter Elwynn Forest</button>
        </div>
      </div>
    </div>
  );
}
