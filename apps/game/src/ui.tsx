// Shared UI pieces: icons, item tooltips, bars, money.
import { useState, type ReactNode } from 'react';
import { formatMoney, itemCategory, ITEM_CATEGORIES, type GameData, type ItemCategory, type ItemDef } from '@idle/sim';

export const iconUrl = (name: string) => `icons/${name.toLowerCase()}.png`;

export function Icon({ name, size, title }: { name: string; size?: 'sm' | 'lg'; title?: string }) {
  return <img className={`icon ${size ?? ''}`} src={iconUrl(name)} alt={title ?? ''} title={title} loading="lazy"
    onError={e => { (e.target as HTMLImageElement).src = iconUrl('INV_Misc_QuestionMark'); }} />;
}

export function Money({ copper }: { copper: number }) {
  const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
  return (
    <span className="money" aria-label={formatMoney(copper)}>
      {g > 0 && <span>{g}<img src={iconUrl('INV_Misc_Coin_01')} alt="g" /></span>}
      {(g > 0 || s > 0) && <span>{s}<img src={iconUrl('INV_Misc_Coin_03')} alt="s" /></span>}
      <span>{c}<img src={iconUrl('INV_Misc_Coin_05')} alt="c" /></span>
    </span>
  );
}

export function Bar({ value, max, kind, label, thin }: { value: number; max: number; kind: string; label?: string; thin?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`bar ${kind} ${thin ? 'thin' : ''}`}>
      <div className="fill" style={{ width: `${pct}%` }} />
      {label !== undefined && <div className="label">{label}</div>}
    </div>
  );
}

// ---- tooltips: a single floating element that follows the cursor
let setTip: ((t: { x: number; y: number; body: ReactNode } | null) => void) | null = null;

export function TooltipHost() {
  const [tip, set] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  setTip = set;
  if (!tip) return null;
  const left = Math.min(tip.x + 16, innerWidth - 330), top = Math.min(tip.y + 16, innerHeight - 200);
  return <div className="tip" style={{ left, top }}>{tip.body}</div>;
}

export function withTip(body: () => ReactNode) {
  return {
    onMouseMove: (e: React.MouseEvent) => setTip?.({ x: e.clientX, y: e.clientY, body: body() }),
    onMouseLeave: () => setTip?.(null),
  };
}

const STAT_NAMES: Record<number, string> = { 3: 'Agility', 4: 'Strength', 5: 'Intellect', 6: 'Spirit', 7: 'Stamina' };
const SLOT_NAMES: Record<number, string> = {
  1: 'Head', 2: 'Neck', 3: 'Shoulder', 5: 'Chest', 6: 'Waist', 7: 'Legs', 8: 'Feet', 9: 'Wrist', 10: 'Hands',
  11: 'Finger', 12: 'Trinket', 13: 'One-Hand', 14: 'Off Hand', 15: 'Ranged', 16: 'Back', 17: 'Two-Hand',
  20: 'Chest', 21: 'Main Hand', 22: 'Off Hand', 23: 'Held In Off-hand', 25: 'Thrown', 26: 'Ranged',
};

export function ItemTooltip({ item, data, count }: { item: ItemDef; data: GameData; count?: number }) {
  void data;
  return (
    <div>
      <div className={`t-name q${item.quality}`}>{item.name}</div>
      {item.invType > 0 && <div className="t-line">{SLOT_NAMES[item.invType] ?? ''}</div>}
      {item.dmgMax > 0 && <div className="t-line">{item.dmgMin} - {item.dmgMax} Damage <span className="t-muted">Speed {(item.delayMs / 1000).toFixed(2)}</span></div>}
      {item.dmgMax > 0 && <div className="t-muted">({(((item.dmgMin + item.dmgMax) / 2) / (item.delayMs / 1000)).toFixed(1)} damage per second)</div>}
      {item.armor > 0 && <div className="t-line">{item.armor} Armor</div>}
      {!!item.bagSlots && <div className="t-line">{item.bagSlots} Slot {item.bagFamily ? (item.class === 11 ? (item.subclass === 3 ? "Ammo Pouch" : "Quiver") : "Special Bag") : "Bag"}</div>}
      {item.stats.map(([t, v], i) => <div key={i} className="t-line">+{v} {STAT_NAMES[t] ?? `Stat ${t}`}</div>)}
      {item.food && <div className="t-green">Use: Restores {item.food.heal > 0 ? `${item.food.heal} health` : `${item.food.mana} mana`} over {item.food.durationMs / 1000} sec.</div>}
      {item.reqLevel > 1 && <div className="t-line">Requires Level {item.reqLevel}</div>}
      {item.tool && <div className="t-muted">Tool: {item.tool === 'mining-pick' ? 'Mining' : 'Fishing'}</div>}
      {count !== undefined && count > 1 && <div className="t-muted">You have {count}</div>}
      {item.sellPrice > 0 && <div className="t-muted" style={{ marginTop: 4 }}>Sell Price: <Money copper={item.sellPrice} /></div>}
    </div>
  );
}

export function ItemIcon({ id, data, count, size, onClick, selected }: {
  id: number; data: GameData; count?: number; size?: 'sm' | 'lg'; onClick?: () => void; selected?: boolean;
}) {
  const item = data.items[id];
  if (!item) return null;
  return (
    <span className={`itemicon q${item.quality} ${selected ? 'sel' : ''}`} onClick={onClick}
      {...withTip(() => <ItemTooltip item={item} data={data} count={count} />)}>
      <Icon name={item.icon} size={size} />
      {count !== undefined && count > 1 && <span className="count">{count}</span>}
    </span>
  );
}

export const colorClass = (c: string) => `c-${c}`;
export const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`;
};

/** Hides the floating tooltip (its element may unmount without a mouseleave, e.g. on page change). */
export function hideTip(): void { setTip?.(null); }

/**
 * Search box + category chips for a list of items (bags, vendors, the guild bank). Returns the bar to
 * render and the matching ids grouped by category, in category order.
 */
export function useItemFilter(data: GameData, ids: number[]) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<ItemCategory | 'All'>('All');
  const counts = new Map<ItemCategory, number>();
  const catOf = new Map<number, ItemCategory>();
  for (const id of ids) {
    const it = data.items[id];
    if (!it) continue;
    const c = itemCategory(data, it);
    catOf.set(id, c);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const needle = q.trim().toLowerCase();
  const filtered = ids.filter(id => catOf.has(id) && (cat === 'All' || catOf.get(id) === cat) && (!needle || data.items[id].name.toLowerCase().includes(needle)));
  const groups = ITEM_CATEGORIES.map(c => [c, filtered.filter(id => catOf.get(id) === c)] as const).filter(([, l]) => l.length);
  const active = cat !== 'All' && !counts.has(cat) ? 'All' : cat;
  const bar = (
    <div className="filterbar">
      <input className="text" placeholder="Search items" value={q} onChange={e => setQ(e.target.value)} />
      <button className={`chip ${active === 'All' ? 'on' : ''}`} onClick={() => setCat('All')}>All {ids.length}</button>
      {ITEM_CATEGORIES.filter(c => counts.has(c)).map(c => (
        <button key={c} className={`chip ${active === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c} {counts.get(c)}</button>))}
    </div>
  );
  return { bar, groups, filtered };
}

/** A plain search box for non-item lists (quests, recipes, spells). */
export function useSearch(placeholder = 'Search') {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  return {
    box: <input className="text search" placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} />,
    match: (...texts: (string | undefined)[]) => !needle || texts.some(t => t?.toLowerCase().includes(needle)),
  };
}
