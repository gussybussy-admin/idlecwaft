// Class pages: spellbook + class trainer, talent trees, and the power bar (mana / rage / energy).
import {
  canLearnTalent, knownSpells, modded, activeTalentEffects, playerStats, pointsInTab, pointsSpent, resetCost, talentPoints,
  trainableSpells, usesMana, POINTS_PER_ROW, type GameData, type GameState, type SpellDef, type TalentDef, type TalentEffect,
} from '@idle/sim';
import { game } from './game.js';
import { Bar, Icon, Money, useSearch, withTip } from './ui.js';

type P = { s: GameState; data: GameData };

/** The class's resource bar, or nothing for a class without one at this level. */
export function PowerBar({ s, data, thin }: P & { thin?: boolean }) {
  if (s.char.cls === 1) { const r = Math.floor((s.char.rage ?? 0) / 10); return <Bar kind="rage" thin={thin} value={r} max={100} label={`${r} / 100`} />; }
  if (s.char.cls === 4) { const e = Math.floor(s.char.energy ?? 0); return <Bar kind="energy" thin={thin} value={e} max={100} label={`${e} / 100`} />; }
  if (!usesMana(s, data)) return null;
  const max = playerStats(s, data).maxMana, m = Math.min(max, Math.floor(s.char.mana ?? 0));
  return <Bar kind="mana" thin={thin} value={m} max={max} label={`${m} / ${max}`} />;
}

const SCHOOLS = ['Physical', 'Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'];
const fmtCost = (sp: SpellDef, cost: number) => !cost || sp.power === 'health' ? 'No cost'
  : sp.power === 'rage' ? `${cost / 10} Rage` : sp.power === 'energy' ? `${cost} Energy` : `${cost} Mana`;

function SpellTip({ sp, s }: { sp: SpellDef; s: GameState }) {
  const m = modded(sp, game.data ? activeTalentEffects(s, game.data) : []);
  return (
    <div>
      <div className="t-name">{sp.name} {sp.rank && <span className="t-muted">{sp.rank}</span>}</div>
      <div>{fmtCost(sp, m.cost)}{m.castMs ? ` · ${(m.castMs / 1000).toFixed(1)} sec cast` : ' · Instant'}{m.cooldownMs ? ` · ${Math.round(m.cooldownMs / 1000)} sec cooldown` : ''}</div>
      <div className="t-muted">{SCHOOLS[sp.school] ?? ''} · learned at level {sp.spellLevel || 1}</div>
      {m.dmgMult !== 1 && <div className="c-green">Talents: {Math.round((m.dmgMult - 1) * 100)}% more damage</div>}
      {m.critBonus > 0 && <div className="c-green">Talents: +{m.critBonus}% critical strike chance</div>}
    </div>
  );
}

export function SpellbookPage({ s, data }: P) {
  const { box, match } = useSearch('Search spells');
  const known = knownSpells(s, data).filter(sp => match(sp.name)).sort((a, b) => (a.spellLevel - b.spellLevel) || a.name.localeCompare(b.name));
  const offers = trainableSpells(s, data);
  const upcoming = (data.classSpells?.[s.char.cls] ?? []).filter(o => o.level > s.char.level && o.level <= s.char.level + 6 && !s.spells.includes(o.spell));
  const total = offers.reduce((a, o) => a + o.cost, 0);
  const trainerZones = data.classTrainerZones?.[s.char.cls] ?? [];
  const here = trainerZones.includes(s.zone);
  const cls = data.classes.find(c => c.id === s.char.cls)?.name ?? '';
  const offerCard = (o: { spell: number; level: number; cost: number }, dim?: boolean) => {
    const sp = data.spells[o.spell];
    if (!sp) return null;
    return (
      <div key={o.spell} className="card" style={dim ? { opacity: 0.55 } : undefined} {...withTip(() => <SpellTip sp={sp} s={s} />)}>
        <div className="row"><Icon name={sp.icon} /><div style={{ minWidth: 0 }}><div className="title">{sp.name}</div>
          <div className="meta">{sp.rank || 'Spell'} · level {o.level} · {o.cost ? <Money copper={o.cost} /> : 'free'}</div></div></div>
      </div>
    );
  };
  return (
    <>
      <div className="panel-head"><h2>Spellbook</h2><span className="muted">{known.length} spells the rotation can use</span><span className="spacer" />{box}</div>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>In a fight your character casts these on their own: the strongest affordable spell first, heals when hurt, buffs and seals kept up.</p>
        <div className="grid">
          {known.map(sp => (
            <div key={sp.id} className="card" {...withTip(() => <SpellTip sp={sp} s={s} />)}>
              <div className="row"><Icon name={sp.icon} /><div style={{ minWidth: 0 }}><div className="title">{sp.name}</div>
                <div className="meta">{sp.rank || ' '} · {fmtCost(sp, sp.cost)}</div></div></div>
            </div>
          ))}
          {!known.length && <span className="muted">No spells yet: visit your class trainer.</span>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>{cls} trainer</h3><span className="spacer" />
          {offers.length > 0 && <button className="btn" disabled={!here || s.gold < total} onClick={() => game.command({ name: 'trainSpells' })}>
            Train all ({offers.length}) {total ? <Money copper={total} /> : 'free'}</button>}</div>
        {!here && <p className="muted" style={{ marginTop: 0 }}>No {cls.toLowerCase()} trainer in this zone. Trainers: {trainerZones.map(z => data.zones.find(x => x.id === z)?.name).filter(Boolean).join(', ') || 'none'}.</p>}
        {offers.length ? <div className="grid">{offers.filter(o => match(data.spells[o.spell]?.name)).map(o => offerCard(o))}</div> : <p className="muted">Nothing new to learn at level {s.char.level}.</p>}
        {upcoming.length > 0 && <><h3 style={{ marginTop: 16 }}>Coming up</h3><div className="grid">{upcoming.map(o => offerCard(o, true))}</div></>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- talents

const STAT_NAMES: Record<string, string> = { str: 'Strength', agi: 'Agility', sta: 'Stamina', int: 'Intellect', spi: 'Spirit', all: 'all stats' };
function fxText(e: TalentEffect, data: GameData): string {
  switch (e.k) {
    case 'stat': return `+${e.amount} ${STAT_NAMES[e.stat]}`;
    case 'statPct': return `+${e.pct}% ${STAT_NAMES[e.stat]}`;
    case 'healthPct': return `+${e.pct}% health`;
    case 'manaPct': return `+${e.pct}% mana`;
    case 'meleeCrit': return `+${e.pct}% melee crit`;
    case 'spellCrit': return `+${e.pct}% spell crit`;
    case 'meleeHit': return `+${e.pct}% melee hit`;
    case 'spellHit': return `+${e.pct}% spell hit`;
    case 'dodge': return `+${e.pct}% dodge`;
    case 'armor': return `+${e.amount} armor`;
    case 'armorPct': return `+${e.pct}% armor`;
    case 'ap': return `+${e.amount} attack power`;
    case 'schoolDamage': return `+${e.pct}% ${SCHOOLS.filter((_, i) => e.schools & (1 << i)).join('/')} damage`;
    case 'spellMod': {
      const names = Object.values(data.spells).filter(sp => sp.family === e.family && (sp.familyFlags & e.mask)).map(sp => sp.name);
      const which = [...new Set(names)].slice(0, 4).join(', ') || 'some spells';
      const v = e.flat || e.pct, unit = e.pct ? '%' : e.op === 'castTime' || e.op === 'cooldown' ? ' ms' : e.op === 'crit' ? '%' : '';
      const op = { damage: 'damage', crit: 'crit chance', castTime: 'cast time', cost: 'cost', cooldown: 'cooldown' }[e.op];
      return `${which}: ${v > 0 ? '+' : ''}${e.op === 'castTime' && e.flat ? (v / 1000).toFixed(1) + ' sec' : e.op === 'cooldown' && e.flat ? (v / 1000).toFixed(1) + ' sec' : v + unit} ${op}`;
    }
  }
}

function TalentTip({ t, rank, s, data }: { t: TalentDef; rank: number; s: GameState; data: GameData }) {
  const cur = rank > 0 ? t.effects[rank - 1] : null, next = rank < t.ranks.length ? t.effects[rank] : null;
  const err = rank < t.ranks.length ? canLearnTalent(s, data, t.id) : null;
  const idle = t.effects.some(e => e.length);
  return (
    <div style={{ maxWidth: 300 }}>
      <div className="t-name">{t.name}</div>
      <div className="t-muted">Rank {rank}/{t.ranks.length}</div>
      <div style={{ margin: '4px 0' }}>{t.description}</div>
      {cur && cur.length > 0 && <div className="c-green">Now: {cur.map(e => fxText(e, data)).join('; ')}</div>}
      {next && next.length > 0 && <div style={{ color: '#ffd100' }}>Next rank: {next.map(e => fxText(e, data)).join('; ')}</div>}
      {!idle && <div className="t-muted">Doesn't affect idle combat yet.</div>}
      {err && <div className="c-red">{err}</div>}
    </div>
  );
}

export function TalentsPage({ s, data }: P) {
  const tabs = Object.values(data.talentTabs ?? {}).filter(t => t.cls === s.char.cls).sort((a, b) => a.order - b.order);
  const avail = talentPoints(s.char.level), spent = pointsSpent(s), free = avail - spent;
  const cost = resetCost(s);
  return (
    <>
      <div className="panel-head"><h2>Talents</h2><span className="muted">{free} point{free === 1 ? '' : 's'} to spend · {spent} spent</span><span className="spacer" />
        {spent > 0 && <button className="btn secondary" disabled={s.gold < cost} onClick={() => confirm(`Unlearn all talents for ${Math.floor(cost / 10000)}g?`) && game.command({ name: 'resetTalents' })}>
          Unlearn talents <Money copper={cost} /></button>}</div>
      {s.char.level < 10 && <p className="muted">You earn your first talent point at level 10, then one per level.</p>}
      <div className="talent-trees">
        {tabs.map(tab => {
          const ts = Object.values(data.talents).filter(t => t.tab === tab.id);
          const inTab = pointsInTab(s, data, tab.id);
          const rows = Math.max(7, ...ts.map(t => t.row + 1));
          return (
            <div key={tab.id} className="panel talent-tree">
              <div className="panel-head"><Icon name={tab.icon} size="sm" /><h3>{tab.name}</h3><span className="spacer" /><span className="muted">{inTab}</span></div>
              <div className="talent-grid" style={{ gridTemplateRows: `repeat(${rows}, 48px)` }}>
                {ts.map(t => {
                  const rank = s.talents[t.id] ?? 0;
                  const ok = !canLearnTalent(s, data, t.id);
                  const locked = rank === 0 && inTab < t.row * POINTS_PER_ROW;
                  return (
                    <button key={t.id} className={`talent ${rank ? 'has' : ''} ${ok ? 'can' : ''} ${locked ? 'locked' : ''} ${rank === t.ranks.length ? 'max' : ''}`}
                      style={{ gridRow: t.row + 1, gridColumn: t.col + 1 }}
                      onClick={() => ok && game.command({ name: 'learnTalent', talent: t.id })}
                      {...withTip(() => <TalentTip t={t} rank={rank} s={s} data={data} />)}>
                      <Icon name={t.icon} />
                      <span className="rank">{rank}/{t.ranks.length}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
