// Guild page: roster, activity feed, chat, bank, requests and the bank log.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameData, GameState, GuildSnapshot } from '@idle/sim';
import { game } from './game.js';
import { fmtTime, ItemIcon, Money } from './ui.js';

type P = { s: GameState; data: GameData; g: GuildSnapshot };

export function GuildPage({ s, data, g }: P) {
  useEffect(() => { game.markChatRead(true); return () => game.markChatRead(false); }, []);
  const online = g.roster.filter(r => r.online).length;
  return (
    <>
      <div className="panel-head"><h2>&lt;{g.name}&gt;</h2><span className="muted">{g.roster.length} members · {online} online</span></div>
      <div className="guild-cols">
        <Roster g={g} data={data} />
        <Chat g={g} />
      </div>
      <Feed g={g} />
      <Bank s={s} data={data} g={g} />
      <Requests s={s} data={data} g={g} />
      <BankLog data={data} g={g} />
    </>
  );
}

function Roster({ g, data }: Omit<P, 's'>) {
  const cls = (id: number) => data.classes.find(c => c.id === id)?.name ?? '';
  const race = (id: number) => data.races.find(r => r.id === id)?.name ?? '';
  return (
    <div className="panel tight">
      <div className="panel-head"><h3>Members</h3></div>
      <div className="roster">
        {g.roster.map(m => (
          <div key={m.accountId} className={`member ${m.online ? 'on' : ''}`}>
            <span className="dot" title={m.online ? 'Online' : 'Offline'} />
            <div style={{ minWidth: 0 }}>
              <div className="mname">{m.name} <span className="muted">{m.level} {race(m.race)} {cls(m.cls)}</span></div>
              <div className="meta">{m.activity}{!m.online && ` · seen ${fmtTime(Date.now() - m.lastSeen)} ago`}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chat({ g }: { g: GuildSnapshot }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [g.chat.length]);
  const send = () => { if (text.trim()) { game.chat(text); setText(''); } };
  return (
    <div className="panel tight chat">
      <div className="panel-head"><h3>Guild chat</h3></div>
      <div className="chatlog" ref={box}>
        {g.chat.map(m => (
          <div key={m.id}><span className="faint">{new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{' '}
            <span className="guild-who">[{m.who}]</span>: {m.text}</div>
        ))}
        {!g.chat.length && <div className="faint">No messages yet. Say hello!</div>}
      </div>
      <div className="btn-row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
        <input className="text" value={text} maxLength={300} placeholder="Message the guild" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }} />
        <button className="btn" onClick={send}>Send</button>
      </div>
    </div>
  );
}

function Feed({ g }: { g: GuildSnapshot }) {
  return (
    <div className="panel tight">
      <div className="panel-head"><h3>Activity</h3></div>
      <div className="feed">
        {g.feed.map(f => <div key={f.id} className={`fi ${f.kind}`}><span className="faint">{fmtTime(Date.now() - f.t)} ago</span> {f.text}</div>)}
        {!g.feed.length && <div className="faint">Nothing yet.</div>}
      </div>
    </div>
  );
}

function Bank({ s, data, g }: P) {
  const [sel, setSel] = useState<{ from: 'bank' | 'bags'; item: number } | null>(null);
  const [count, setCount] = useState(1);
  const [gold, setGold] = useState('');
  const bags = Object.entries(s.inventory).map(([i, n]) => [Number(i), n] as [number, number])
    .filter(([i]) => data.items[i] && !data.items[i].tool)
    .sort((a, b) => data.items[b[0]].quality - data.items[a[0]].quality || data.items[a[0]].name.localeCompare(data.items[b[0]].name));
  const have = sel ? (sel.from === 'bank' ? g.bank.find(b => b.item === sel.item)?.count ?? 0 : s.inventory[sel.item] ?? 0) : 0;
  const pick = (from: 'bank' | 'bags', item: number, n: number) => { setSel(sel?.item === item && sel.from === from ? null : { from, item }); setCount(n); };
  const copper = Math.round(parseFloat(gold || '0') * 10000);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Guild bank</h3><span className="spacer" /><Money copper={g.gold} /></div>
      <div className="bank-cols">
        <div>
          <div className="meta" style={{ marginBottom: 6 }}>In the bank</div>
          <div className="bag">{g.bank.map(b => (
            <div key={b.item} className={`slot ${sel?.from === 'bank' && sel.item === b.item ? 'sel' : ''}`} onClick={() => pick('bank', b.item, b.count)}>
              <ItemIcon id={b.item} data={data} count={b.count} /></div>))}
            {!g.bank.length && <span className="faint">Empty.</span>}</div>
        </div>
        <div>
          <div className="meta" style={{ marginBottom: 6 }}>Your bags</div>
          <div className="bag">{bags.map(([i, n]) => (
            <div key={i} className={`slot ${sel?.from === 'bags' && sel.item === i ? 'sel' : ''}`} onClick={() => pick('bags', i, n)}>
              <ItemIcon id={i} data={data} count={n} /></div>))}
            {!bags.length && <span className="faint">Empty.</span>}</div>
        </div>
      </div>
      {sel && have > 0 && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <ItemIcon id={sel.item} data={data} size="sm" />
          <span className={`q${data.items[sel.item]?.quality}`}>{data.items[sel.item]?.name}</span>
          <input className="text" type="number" min={1} max={have} value={count} style={{ width: 80 }} onChange={e => setCount(Math.max(1, Math.min(have, +e.target.value || 1)))} />
          <span className="muted">of {have}</span>
          {sel.from === 'bags'
            ? <button className="btn" onClick={() => game.bank('deposit', { item: sel.item, count }).then(ok => ok && setSel(null))}>Deposit</button>
            : <button className="btn" onClick={() => game.bank('withdraw', { item: sel.item, count }).then(ok => ok && setSel(null))}>Withdraw</button>}
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <span className="muted">Gold</span>
        <input className="text" type="number" min={0} step="0.01" placeholder="0.00" value={gold} style={{ width: 100 }} onChange={e => setGold(e.target.value)} />
        <span className="muted">= <Money copper={Math.max(0, copper)} /></span>
        <button className="btn secondary small" disabled={copper < 1} onClick={() => game.bank('deposit', { gold: copper }).then(ok => ok && setGold(''))}>Deposit</button>
        <button className="btn secondary small" disabled={copper < 1} onClick={() => game.bank('withdraw', { gold: copper }).then(ok => ok && setGold(''))}>Withdraw</button>
      </div>
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>Anyone can deposit or withdraw; every transaction is logged below.</p>
    </div>
  );
}

function Requests({ s, data, g }: P) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(10);
  const [note, setNote] = useState('');
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return Object.values(data.items).filter(i => i.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, 8);
  }, [query, data]);
  const [item, setItem] = useState<number | null>(null);
  const open = g.requests.filter(r => r.open), done = g.requests.filter(r => !r.open).slice(0, 6);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Requests</h3><span className="muted">Ask the guild for materials; anyone who has them can send them to you.</span></div>
      <div className="grid">
        {open.map(r => {
          const mine = r.accountId === game.account?.id;
          const have = s.inventory[r.item] ?? 0, left = r.count - r.filled;
          return (
            <div key={r.id} className="card">
              <div className="row"><ItemIcon id={r.item} data={data} />
                <div style={{ minWidth: 0 }}><div className={`title q${data.items[r.item]?.quality}`}>{r.filled}/{r.count} {data.items[r.item]?.name}</div>
                  <div className="meta">{r.who}{r.note ? ` · "${r.note}"` : ''}</div></div></div>
              <div className="btn-row">
                {mine ? <button className="btn secondary small" onClick={() => game.cancelRequest(r.id)}>Cancel</button>
                  : <button className="btn small" disabled={!have} onClick={() => game.fillRequest(r.id, Math.min(have, left))}>
                    {have ? `Send ${Math.min(have, left)}` : "You don't have any"}</button>}
              </div>
            </div>
          );
        })}
        {!open.length && <span className="faint">No open requests.</span>}
      </div>
      <div className="btn-row" style={{ marginTop: 14, position: 'relative' }}>
        <input className="text" style={{ maxWidth: 240 }} placeholder="Item name, e.g. Copper Ore" value={item ? data.items[item]?.name : query}
          onChange={e => { setItem(null); setQuery(e.target.value); }} />
        <input className="text" type="number" min={1} max={1000} value={count} style={{ width: 80 }} onChange={e => setCount(Math.max(1, Math.min(1000, +e.target.value || 1)))} />
        <input className="text" style={{ maxWidth: 220 }} placeholder="Note (optional)" maxLength={80} value={note} onChange={e => setNote(e.target.value)} />
        <button className="btn" disabled={!item} onClick={() => item && game.createRequest(item, count, note).then(ok => { if (ok) { setItem(null); setQuery(''); setNote(''); } })}>Request</button>
        {!item && matches.length > 0 && (
          <div className="suggest">{matches.map(m => (
            <button key={m.id} onClick={() => { setItem(m.id); setQuery(''); }}><ItemIcon id={m.id} data={data} size="sm" /> <span className={`q${m.quality}`}>{m.name}</span></button>))}</div>
        )}
      </div>
      {done.length > 0 && <div className="meta" style={{ marginTop: 10 }}>Recently closed: {done.map(r => `${r.who}'s ${r.filled}/${r.count} ${data.items[r.item]?.name}`).join(' · ')}</div>}
    </div>
  );
}

function BankLog({ data, g }: { data: GameData; g: GuildSnapshot }) {
  return (
    <div className="panel tight">
      <div className="panel-head"><h3>Bank log</h3></div>
      <div className="log" style={{ flexDirection: 'column' }}>
        {g.log.map(l => (
          <div key={l.id}>
            <span className="faint">{new Date(l.t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>{' '}
            {l.who} {l.kind === 'deposit' ? 'deposited' : l.kind === 'withdraw' ? 'withdrew' : 'sent'}{' '}
            {l.item ? <span className={`q${data.items[l.item]?.quality}`}>{l.count}x {data.items[l.item]?.name}</span> : <Money copper={l.gold} />}
            {l.note && <span className="muted"> {l.note}</span>}
          </div>
        ))}
        {!g.log.length && <span className="faint">No transactions yet.</span>}
      </div>
    </div>
  );
}
