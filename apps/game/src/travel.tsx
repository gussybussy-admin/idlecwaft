// Travel page: every zone of both continents, how long it takes to get there and how.
import { useEffect, useState } from 'react';
import { factionOfRace, planTravel, RIDING, type GameData, type GameState } from '@idle/sim';
import { game } from './game.js';
import { Bar, fmtTime, Money } from './ui.js';
import { ActionScene } from './pages.js';

type P = { s: GameState; data: GameData };
const CONTINENTS = ['Eastern Kingdoms', 'Kalimdor'];

export function TravelPage({ s, data }: P) {
  const here = data.zones.find(z => z.id === s.zone)!;
  const travelling = s.action?.kind === 'travel' ? s.action.to : null;
  const faction = factionOfRace(data, s.char.race);
  const known = s.taxi.filter(id => data.taxiNodes[id]);
  const nextRiding = RIDING.find(r => r.bonus > s.riding);
  return (
    <>
      <div className="panel-head"><h2>Travel</h2><span className="muted">You are in {here.name}</span></div>
      <ActionScene s={s} data={data} hint={`In ${here.name}`} />
      {travelling !== null && <TravelProgress s={s} data={data} to={travelling} />}
      <div className="panel tight">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Flight paths known: {known.length} {known.length > 0 && <span className="faint">({known.map(id => data.taxiNodes[id].name.split(',')[0]).join(', ')})</span>}</span>
          {nextRiding
            ? <button className="btn secondary small" onClick={() => game.command({ name: 'trainRiding' })}>
                {nextRiding.name} (+{nextRiding.bonus}% speed) · <Money copper={nextRiding.cost} /> · level {nextRiding.reqLevel}</button>
            : <span className="muted">Riding: +{s.riding}% speed</span>}
        </div>
        <p className="faint" style={{ fontSize: 12, margin: '6px 0 0' }}>
          You learn a zone's flight path when you arrive there. Boats and zeppelins connect the continents
          ({faction === 'alliance' ? 'Menethil Harbor, Auberdine, Booty Bay' : 'Undercity, Grom\'gol, Booty Bay'}).
        </p>
      </div>
      {CONTINENTS.map((name, map) => (
        <div key={name} className="panel">
          <div className="panel-head"><h3>{name}</h3></div>
          <div className="grid">
            {data.zones.filter(z => z.map === map).map(z => {
              const plan = z.id === s.zone ? null : planTravel(s, data, z.id);
              const diff = z.levelMin - s.char.level;
              const con = z.city ? '' : diff >= 5 ? 'c-red' : diff >= 2 ? 'c-orange' : z.levelMax < s.char.level - 8 ? 'c-grey' : z.levelMax < s.char.level - 3 ? 'c-green' : 'c-yellow';
              return (
                <div key={z.id} className={`card ${z.id === s.zone ? 'current' : ''}`}>
                  <div className="row"><div style={{ minWidth: 0, flex: 1 }}>
                    <div className={`title ${con}`}>{z.name}</div>
                    <div className="meta">{z.city ? 'City' : `Level ${z.levelMin}-${z.levelMax}`} · {z.creatures.length} creature types{z.nodes.length ? ` · ${z.nodes.length} herbs/ores` : ''}</div>
                  </div></div>
                  {z.id === s.zone ? <span className="muted">You are here.</span> : plan ? (
                    <div className="btn-row">
                      <button className="btn small" disabled={travelling !== null} onClick={() => game.command({ name: 'start', action: { kind: 'travel', to: z.id } })}>
                        Travel · {fmtTime(plan.ms)}</button>
                      <span className="faint" style={{ fontSize: 12 }}>{plan.legs.map(l => l.kind === 'fly' ? '✈' : l.kind === 'boat' ? '⛵' : '🏃').join(' ')}{plan.cost > 0 && <> · <Money copper={plan.cost} /></>}</span>
                    </div>
                  ) : <span className="faint">No route for your faction.</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

function TravelProgress({ s, data, to }: P & { to: number }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force(x => x + 1), 250); return () => clearInterval(t); }, []);
  const ph = s.phase;
  const dest = data.zones.find(z => z.id === to)?.name;
  if (ph.p !== 'work') return null;
  const left = Math.max(0, ph.until - game.serverNow);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Travelling to {dest}</h3><span className="spacer" /><span className="muted">{fmtTime(left)} left</span></div>
      <Bar kind="work" value={game.serverNow - ph.from} max={ph.until - ph.from} />
    </div>
  );
}
