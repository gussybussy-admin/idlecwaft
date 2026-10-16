// Production professions (one page for every crafting skill), disenchanting, and skinning.
import { useState } from 'react';
import {
  hasSpecFor, specById, specError, SPECS,
  canCraft, disenchantReq, enchantSlot, gatherColor, recipeColor, SKILL_NAME, SKINNING_KNIFE, skinningReq,
  type GameData, type GameState, type Profession, type RecipeDef,
} from '@idle/sim';
import { game } from './game.js';
import { ActionScene, SkillHeader, SKILL_ICON, WorkBar } from './pages.js';
import { colorClass, Icon, ItemIcon, ItemTooltip, Money, withTip } from './ui.js';

type P = { s: GameState; data: GameData };
type Filter = 'known' | 'learn' | 'all';

const productIcon = (r: RecipeDef, data: GameData, size?: 'sm' | 'lg') => r.item
  ? <ItemIcon id={r.item} data={data} size={size} />
  : <Icon name={SKILL_ICON.enchanting} size={size} title={data.enchants[r.enchant!.id]?.name} />;

/** Specializations for this profession: pick one per choice (switching forgets the old one's recipes). */
function SpecPanel({ s, data, skill }: P & { skill: Profession }) {
  const specs = SPECS.filter(x => x.skill === skill);
  if (!specs.length || !s.skills[skill]?.max) return null;
  const count = (id: number) => Object.values(data.recipes).filter(r => r.spec === id).length;
  return (
    <div className="panel">
      <div className="panel-head"><h3>Specialization</h3><span className="muted">Each unlocks its own recipes; switching forgets the other's.</span></div>
      <div className="grid">{specs.map(sp => {
        const mine = s.specs?.includes(sp.id), err = specError(s, sp);
        return (
          <div key={sp.id} className={`card ${mine ? 'current' : ''}`}>
            <div className="title">{sp.name}</div>
            <div className="meta">{count(sp.id)} recipes · skill {sp.reqSkill}, level {sp.reqLevel}{sp.requires ? ` · after ${specById(sp.requires)?.name}` : ''}</div>
            <div className="btn-row">{mine ? <span className="tag">Yours</span>
              : <button className="btn secondary small" disabled={!!err} title={err ?? ''} onClick={() => game.command({ name: 'specialize', spec: sp.id })}>Specialize (<Money copper={sp.cost} />)</button>}</div>
          </div>
        );
      })}</div>
    </div>
  );
}

export function CraftPage({ s, data, skill, embedded }: P & { skill: Profession; embedded?: boolean }) {
  const sk = s.skills[skill];
  const [filter, setFilter] = useState<Filter>('known');
  const [q, setQ] = useState('');
  const current = s.action?.kind === 'craft' ? s.action.recipe : null;
  const all = Object.values(data.recipes).filter(r => r.skill === skill).sort((a, b) => a.orange - b.orange || a.name.localeCompare(b.name));
  const known = (r: RecipeDef) => s.recipes.includes(r.spellId);
  const learnable = (r: RecipeDef) => !known(r) && r.orange <= sk.level + 25 && hasSpecFor(s, r.spec)
    && ('trainer' in r.source || (s.inventory[r.source.recipeItem] ?? 0) > 0);
  const shown = all.filter(r => (filter === 'known' ? known(r) : filter === 'learn' ? learnable(r) : true)
    && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  const LIMIT = 60;
  return (
    <>
      {!embedded && <SkillHeader s={s} data={data} skill={skill} />}
      {!embedded && <ActionScene s={s} data={data} hint="Pick a recipe to make" />}
      {!embedded && <SpecPanel s={s} data={data} skill={skill} />}
      <div className="panel">
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <h3>{embedded ? 'Smelting' : 'Recipes'}</h3>
          <span className="muted">{all.filter(known).length} known of {all.length}</span><span className="spacer" />
          <input className="text" style={{ width: 160 }} placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
          {(['known', 'learn', 'all'] as Filter[]).map(f => <button key={f} className={`choice ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'known' ? 'Known' : f === 'learn' ? `Learnable (${all.filter(learnable).length})` : 'All'}</button>)}
        </div>
        {!sk.max && <p className="muted" style={{ marginTop: 0 }}>Train {SKILL_NAME[skill]} to start learning recipes.</p>}
        <div className="grid">
          {shown.slice(0, LIMIT).map(r => <RecipeCard key={r.spellId} s={s} data={data} r={r} current={current === r.spellId} known={known(r)} />)}
        </div>
        {shown.length > LIMIT && <p className="faint">…and {shown.length - LIMIT} more. Search to narrow the list.</p>}
        {!shown.length && <p className="muted">{filter === 'known' ? 'No recipes known yet. Look under Learnable.' : 'Nothing here.'}</p>}
      </div>
      {skill === 'enchanting' && <DisenchantPanel s={s} data={data} />}
    </>
  );
}

function RecipeCard({ s, data, r, current, known }: P & { r: RecipeDef; current: boolean; known: boolean }) {
  const sk = s.skills[r.skill];
  const color = sk.max ? recipeColor(sk.level, r) : 'red';
  const err = canCraft(s, data, r.spellId);
  const makeable = Math.min(...r.reagents.map(([i, n]) => Math.floor((s.inventory[i] ?? 0) / n)));
  const target = r.enchant ? enchantSlot(s, data, r) : null;
  const start = (count?: number) => game.command({ name: 'start', action: { kind: 'craft', recipe: r.spellId, ...(count ? { count } : {}) } });
  const source = 'trainer' in r.source ? (r.source.trainer ? `Trainer` : `Learned with ${SKILL_NAME[r.skill]}`) : `From ${data.items[r.source.recipeItem]?.name ?? 'a recipe'}`;
  return (
    <div className={`card ${current ? 'current' : ''} ${!known ? 'locked' : ''}`}>
      <div className="row">
        <span {...withTip(() => r.item ? <ItemTooltip item={data.items[r.item]} data={data} /> : <div><div className="t-name">{data.enchants[r.enchant!.id]?.name}</div><div className="t-muted">Permanently enchants an equipped item.</div></div>)}>
          {productIcon(r, data, 'lg')}</span>
        <div style={{ minWidth: 0 }}>
          <div className={`title ${colorClass(color)}`}>{r.name}{r.count > 1 ? ` (${r.count})` : ''}</div>
          <div className="meta">{known ? (r.enchant ? (target ? `On your ${data.items[s.equipment[target]!]?.name}` : 'Nothing equipped it fits') : `Can make ${makeable}`) : source}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {r.reagents.map(([i, n]) => (
          <span key={i} className="row" style={{ gap: 4 }} {...withTip(() => <ItemTooltip item={data.items[i]} data={data} />)}><ItemIcon id={i} data={data} size="sm" />
            <span className={(s.inventory[i] ?? 0) >= n ? '' : 'c-red'} style={{ fontSize: 12 }}>{s.inventory[i] ?? 0}/{n}</span></span>))}
        {(r.tools ?? []).map(t => <span key={t} className={`tag ${(s.inventory[t] ?? 0) > 0 ? '' : 'c-red'}`}>{data.items[t]?.name ?? 'tool'}</span>)}
        {r.spec && <span className={`tag ${hasSpecFor(s, r.spec) ? "" : "c-red"}`}>{specById(r.spec)?.name}</span>}
      </div>
      <div className="meta"><span className="c-orange">{r.orange}</span> · <span className="c-yellow">{r.yellow}</span> · <span className="c-green">{r.green}</span> · <span className="c-grey">{r.grey}</span></div>
      {current && <WorkBar s={s} />}
      <div className="btn-row">
        {!known ? <button className="btn secondary" disabled={!sk.max} onClick={() => game.command({ name: 'learnRecipe', recipe: r.spellId })}>
          Learn {'trainer' in r.source ? (r.source.trainer ? <Money copper={r.source.trainer} /> : '') : 'from recipe'}</button>
          : current ? <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>
          : <>
            <button className="btn" disabled={!!err} title={err ?? ''} onClick={() => start(1)}>{r.enchant ? 'Enchant' : 'Create'}</button>
            {!r.enchant && makeable >= 5 && <button className="btn secondary small" disabled={!!err} onClick={() => start(5)}>x5</button>}
            {!r.enchant && makeable > 1 && <button className="btn secondary small" disabled={!!err} onClick={() => start()}>All ({makeable})</button>}
          </>}
        {known && err && !current && <span className="faint" style={{ fontSize: 12 }}>{err}</span>}
      </div>
    </div>
  );
}

function DisenchantPanel({ s, data }: P) {
  const sk = s.skills.enchanting;
  const items = Object.keys(s.inventory).map(Number).map(id => data.items[id]).filter(it => it?.disenchant && it.quality >= 2)
    .sort((a, b) => (a.itemLevel ?? 0) - (b.itemLevel ?? 0));
  return (
    <div className="panel">
      <div className="panel-head"><h3>Disenchant</h3><span className="muted">Turns green and better gear into enchanting materials.</span></div>
      {!items.length ? <p className="muted" style={{ margin: 0 }}>No green or better weapons or armor in your bags.</p> : (
        <div className="grid">
          {items.map(it => {
            const req = disenchantReq(it.itemLevel ?? it.reqLevel);
            const ok = sk.max > 0 && sk.level >= req;
            return (
              <div key={it.id} className="card">
                <div className="row"><span {...withTip(() => <ItemTooltip item={it} data={data} />)}><ItemIcon id={it.id} data={data} count={s.inventory[it.id]} /></span>
                  <div style={{ minWidth: 0 }}><div className={`title q${it.quality}`}>{it.name}</div><div className="meta">Requires Enchanting {req}</div></div></div>
                <div className="btn-row"><button className="btn secondary small" disabled={!ok} onClick={() => game.command({ name: 'disenchant', item: it.id })}>Disenchant</button></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SkinningPage({ s, data }: P) {
  const sk = s.skills.skinning;
  const zone = data.zones.find(z => z.id === s.zone)!;
  const knife = (s.inventory[SKINNING_KNIFE] ?? 0) > 0;
  const beasts = zone.creatures.map(c => data.creatures[c.id]).filter(c => c?.skin);
  return (
    <>
      <SkillHeader s={s} data={data} skill="skinning" />
      <ActionScene s={s} data={data} hint="Hunt a beast below; its corpse is skinned after the kill" />
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>Skinning happens on its own: every beast you kill is skinned if your skill is high enough and you carry a Skinning Knife.</p>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <span className={`tag ${knife ? '' : 'c-red'}`}>{knife ? 'Skinning Knife in bags' : 'No Skinning Knife (trade supply vendors sell one)'}</span>
          <label className="muted" style={{ fontSize: 13 }}><input type="checkbox" checked={s.settings.autoSkin} onChange={e => game.command({ name: 'settings', autoSkin: e.target.checked })} /> Skin my kills</label>
          <span className="muted" style={{ fontSize: 13 }}>{s.stats.skinned} skinned so far</span>
        </div>
        <h3>Skinnable here</h3>
        <div className="grid">
          {beasts.map(c => {
            const lvl = Math.round((c.levelMin + c.levelMax) / 2), req = skinningReq(lvl);
            const color = sk.max ? gatherColor(sk.level, req) : 'red';
            return (
              <div key={c.id} className="card">
                <div className={`title ${colorClass(color)}`}>{c.name}</div>
                <div className="meta">Level {c.levelMin === c.levelMax ? c.levelMin : `${c.levelMin}-${c.levelMax}`} · needs Skinning {req}</div>
                <div className="btn-row"><button className="btn secondary small" onClick={() => game.command({ name: 'start', action: { kind: 'fight', creature: c.id } })}>Hunt</button></div>
              </div>
            );
          })}
          {!beasts.length && <span className="muted">Nothing to skin in {zone.name}.</span>}
        </div>
      </div>
    </>
  );
}
