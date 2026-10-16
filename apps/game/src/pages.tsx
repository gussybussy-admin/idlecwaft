// Game pages: combat, gathering, fishing, cooking, character, town, log.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  canFish, canGather, equipSlots, factionOfRace, fishingCatchChance, gatherColor, killXp, MAX_PRIMARY,
  activePet, HAPPY, UNHAPPY, petFood, EFFECT_NAMES, bagSpace, BANK_SLOTS, bankUsed, roomFor, DEMONS, HUNTER, knownDemons, petStats, rangedStats, TAME_LEVEL, tameError, WARLOCK, playerStats, PRIMARY_PROFESSIONS, rankTerms, REP_RANKS, PROFESSIONS, SKILL_NAME, SLOTS, type GameData, type GameState, type Profession, type SimEvent, type Slot,
} from '@idle/sim';
import { game } from './game.js';
import { Diorama, type Activity } from './diorama.js';
import { sound, type SoundSettings } from './sound.js';
import { topDrops } from './loot-preview.js';
import { PowerBar } from './spells.js';
import { CraftPage } from './crafting.js';
import { Bar, colorClass, fmtTime, Icon, ItemIcon, ItemTooltip, Money, useItemFilter, withTip } from './ui.js';

type P = { s: GameState; data: GameData };
const RANKS = ['Normal', 'Elite', 'Rare Elite', 'Boss', 'Rare'];

// ================================================================ combat

export function CombatPage({ s, data }: P) {
  const zone = data.zones.find(z => z.id === s.zone)!;
  const fighting = s.action?.kind === 'fight' ? s.action.creature : null;
  const [showAll, setShowAll] = useState(false);
  const lvl = s.char.level;
  const faction = factionOfRace(data, s.char.race);
  const list = zone.creatures.filter(c => {
    const d = data.creatures[c.id];
    if (!d.hostile.includes(faction)) return false; // your own faction's guards and townsfolk
    return showAll || (d.levelMax >= lvl - 6 && d.levelMin <= lvl + 4) || c.id === fighting;
  });
  return (
    <>
      <div className="panel-head"><h2>{zone.name}</h2><span className="muted">Levels {zone.levelMin}-{zone.levelMax}</span><span className="spacer" />
        {s.action && <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>}</div>
      <ActionScene s={s} data={data} hint="Pick a creature to fight" />
      <PetPanel s={s} data={data} />
      <div className="panel">
        <div className="panel-head"><h3>Creatures</h3><span className="spacer" />
          <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show all levels</label></div>
        <div className="grid">
          {list.map(({ id, spawns }) => {
            const d = data.creatures[id];
            const avgLvl = Math.round((d.levelMin + d.levelMax) / 2);
            const xp = killXp(lvl, avgLvl, d.rank);
            const st = d.stats[avgLvl - d.levelMin];
            const diff = avgLvl - lvl;
            const con = diff >= 5 ? 'red' : diff >= 3 ? 'orange' : diff >= -2 ? 'yellow' : xp > 0 ? 'green' : 'grey';
            return (
              <div key={id} className={`card ${fighting === id ? 'current' : ''}`}>
                <div className="row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className={`title ${colorClass(con)}`}>{d.name}</div>
                    <div className="meta">Level {d.levelMin === d.levelMax ? d.levelMin : `${d.levelMin}-${d.levelMax}`} · {st.hp} HP · {d.subname || `${spawns} in zone`}</div>
                  </div>
                  {d.rank > 0 && <span className={`tag ${d.rank === 4 || d.rank === 2 ? 'rare' : 'elite'}`}>{RANKS[d.rank]}</span>}
                </div>
                <div className="tags"><span className="tag">{xp} XP</span>{d.goldMax > 0 && <span className="tag"><Money copper={Math.round((d.goldMin + d.goldMax) / 2)} /></span>}<span className="tag">hits {st.dmgMin}-{st.dmgMax}</span></div>
                <div className="row" style={{ gap: 4 }}>{topDrops(data, d.loot, 5).map(([item, pct]) => (
                  <span key={item} {...withTip(() => <><ItemTooltip item={data.items[item]} data={data} /><div className="t-muted">Drop chance ~{pct < 1 ? pct.toFixed(2) : pct.toFixed(0)}%</div></>)}>
                    <ItemIcon id={item} data={data} size="sm" />
                  </span>))}</div>
                <div className="btn-row">
                  {fighting === id
                    ? <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>
                    : <button className="btn" onClick={() => game.command({ name: 'start', action: { kind: 'fight', creature: id } })}>Fight</button>}
                  {s.char.cls === HUNTER && !tameError(s, d, data) && s.pet?.creature !== id && (
                    <button className="btn secondary small" title={s.pet ? `Replaces ${s.pet.name}` : 'It will fight at your side and hold the mob'}
                      onClick={() => game.command({ name: 'tame', creature: id })}>Tame</button>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const DIET = ['meat', 'fish', 'cheese', 'bread', 'fungus', 'fruit'];
const dietText = (mask: number) => DIET.filter((_, i) => mask & (1 << i)).join(', ') || 'nothing';

/** Your pet: a hunter's tamed beast (tame one from the list below) or a warlock's demon (pick one). */
function PetPanel({ s, data }: P) {
  if (s.char.cls !== HUNTER && s.char.cls !== WARLOCK) return null;
  const pet = activePet(s);
  const ranged = s.char.cls === HUNTER ? rangedStats(s, data, playerStats(s, data).agi) : null;
  const w = s.equipment.ranged ? data.items[s.equipment.ranged] : undefined;
  return (
    <div className="panel pet-panel">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="title">{pet ? pet.name : s.char.cls === HUNTER ? 'No pet' : 'No demon'}
            {pet && <span className="tag" style={{ marginLeft: 6 }}>{pet.kind === 'beast' || petStats(s, data, pet).tank ? 'holds the mob' : 'damage'}</span>}
            {pet?.kind === 'beast' && <span className={`tag ${(pet.happiness ?? 500) < UNHAPPY ? 'bad' : ''}`} style={{ marginLeft: 6 }}>{(pet.happiness ?? 500) > HAPPY ? 'Happy (+25% damage)' : (pet.happiness ?? 500) < UNHAPPY ? 'Unhappy (-25% damage)' : 'Content'}</span>}</div>
          {pet?.kind === 'beast' && <div className="meta">{pet.family ? `A ${data.petFamilies?.[pet.family]?.name.toLowerCase() ?? 'beast'}: eats ${dietText(data.petFamilies?.[pet.family]?.diet ?? 0)}. ` : ''}{(() => { const f = petFood(s, data, pet); return f ? `Next meal: ${data.items[f]?.name} (${s.inventory[f]} in your bags).` : 'No food it eats in your bags: it gets unhappy as it fights.'; })()}</div>}
          <div className="meta">{s.char.cls === HUNTER
            ? (s.char.level < TAME_LEVEL ? `You learn Tame Beast at level ${TAME_LEVEL}.` : pet ? 'Your pet holds the mob while you shoot.' : 'Tame a beast of your level or lower from the list below.')
            : 'Your demon fights beside you. The Voidwalker holds the mob; the others deal damage.'}</div>
          {s.char.cls === HUNTER && <div className="meta">{ranged
            ? `Shooting with ${w?.name}: ${ranged.dmgMin}-${ranged.dmgMax} per shot, ${data.items[ranged.ammo]?.name} (${s.inventory[ranged.ammo] ?? 0} left)`
            : w ? `No ${w.subclass === 3 ? 'bullets' : 'arrows'} for your ${w.name}: buy some from a vendor to shoot.` : 'Equip a bow, gun or crossbow and carry ammo to fight from range.'}</div>}
        </div>
        <div className="btn-row">
          {s.char.cls === WARLOCK && knownDemons(s.char.level).map(k => (
            <button key={k} className={`chip ${pet?.kind === k ? 'on' : ''}`} onClick={() => game.command({ name: 'demon', kind: k })}>{DEMONS[k].name}</button>))}
          {s.char.cls === HUNTER && s.pet && <button className="btn secondary small" onClick={() => game.command({ name: 'dismissPet' })}>Release</button>}
        </div>
      </div>
    </div>
  );
}

interface Floater { id: number; x: number; y: number; text: string; cls: string }

/** Workstations shown while crafting (GameObjectDisplayInfo ids from the client). */
const STATION: Partial<Record<Profession, number>> = {
  cooking: 192, blacksmithing: 273, mining: 233, alchemy: 3491, engineering: 2029, enchanting: 4391,
  tailoring: 113, leatherworking: 113, firstaid: 113,
};
const FISHING_BOBBER = 668;

/** The 3D scene for whatever the character is doing: fighting, gathering, fishing, crafting, travelling. */
export function ActionScene({ s, data, hint }: P & { hint?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const dio = useRef<Diorama | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const fid = useRef(0);
  const latest = useRef(s);
  latest.current = s;

  useEffect(() => {
    const d = new Diorama(host.current!);
    const snd = data.sounds;
    let mobId = 0;
    const weaponSound = () => {
      const w = latest.current.equipment.mainhand ? data.items[latest.current.equipment.mainhand] : undefined;
      return snd?.weapons[w?.class === 2 ? w.subclass : -1] ?? snd?.weapons[-1];
    };
    dio.current = d;
    const off = game.onEvent((e: SimEvent) => {
      const float = (who: 'player' | 'mob' | 'pet', text: string, cls: string, over?: 'player' | 'mob' | 'pet') => {
        const p = d.screenPos(over ?? (who === 'mob' ? 'player' : 'mob')); // damage shows over the one hit
        const f = { id: ++fid.current, x: p.x + (Math.random() - 0.5) * 30, y: p.y, text, cls };
        setFloaters(fs => [...fs.slice(-12), f]);
        setTimeout(() => setFloaters(fs => fs.filter(x => x.id !== f.id)), 1100);
      };
      switch (e.type) {
        case 'swing': {
          d.attack(e.who);
          // Sounds: your weapon or spell landing, the mob's attack voice and its pain.
          if (e.who === 'pet') {
            if (e.result === 'hit' || e.result === 'crit') sound.play(snd?.weapons[-1]?.[e.result === 'crit' ? 'crit' : 'hit'], 'effects', 0.6);
          } else if (e.who === 'player') {
            const sp = e.spell ? data.spells[e.spell]?.sound : undefined;
            if (e.result === 'hit' || e.result === 'crit') {
              if (sp) sound.play(sp.impact ?? sp.cast);
              else if (e.ranged) { const r = latest.current.equipment.ranged ? data.items[latest.current.equipment.ranged] : undefined; sound.play(snd?.weapons[r?.subclass ?? 2]?.[e.result === 'crit' ? 'crit' : 'hit']); }
              else { const w = weaponSound(); sound.play(e.result === 'crit' ? w?.crit : w?.hit); }
              if (Math.random() < 0.3) sound.play(data.creatures[mobId]?.sounds?.wound, 'voices');
            } else if (sp?.cast) sound.play(sp.cast);
          } else {
            if (Math.random() < 0.35) sound.play(data.creatures[mobId]?.sounds?.attack, 'voices');
            if (e.result === 'hit' || e.result === 'crit') sound.play(snd?.weapons[-1]?.[e.result === 'crit' ? 'crit' : 'hit'], 'effects', 0.7);
          }
          const target = e.who === 'mob' ? e.target ?? 'player' : 'mob';
          const cls = e.who === 'pet' ? 'player pet' : e.who;
          if (e.result === 'hit' || e.result === 'crit') { d.wound(target, e.result === 'crit'); float(e.who, e.spell ? `${data.spells[e.spell]?.name ?? EFFECT_NAMES[e.spell] ?? ''} ${e.dmg}` : String(e.dmg), `${cls} ${e.result === 'crit' ? 'crit' : ''} ${e.spell ? 'spell' : ''}`, target); }
          else { if (e.result === 'dodge') d.dodge(target); float(e.who, e.result === 'miss' ? 'Miss' : 'Dodge', 'miss', target); }
          break;
        }
        case 'heal': float('player', `+${e.amount}`, 'heal', 'player'); sound.play(e.spell ? data.spells[e.spell]?.sound?.impact ?? data.spells[e.spell]?.sound?.cast : snd?.ui.eat); break;
        case 'spawn': mobId = e.mob.id; d.setMob(data.creatures[e.mob.id]?.displayIds ?? null, Math.floor(e.t / 1000), data.creatures[e.mob.id]?.equip); sound.play(data.creatures[e.mob.id]?.sounds?.aggro, 'voices'); break;
        case 'kill': d.die('mob'); sound.play(data.creatures[e.creature]?.sounds?.death, 'voices'); if (e.gold) sound.play(snd?.ui.coins, 'effects', 0.6); break;
        case 'eat': sound.play(snd?.ui.eat); break;
        case 'petdeath': d.die('pet'); break;
        case 'petfeed': float('pet', `+ ${data.items[e.item]?.name ?? 'food'}`, 'heal', 'pet'); sound.play(snd?.ui.eat, 'effects', 0.6); break;
        case 'death': d.die('player'); d.setActivity('dead'); break;
        case 'revive': d.revive(); d.revivePet(); break;
        case 'harvest':
          if (e.skill === 'skinning' || e.skill === 'mining' || e.skill === 'herbalism') d.harvest();
          {
            const a = latest.current.action;
            const id = a?.kind === 'craft' ? data.recipes[a.recipe]?.sound ?? snd?.activities[e.skill] : e.skill === 'fishing' ? snd?.activities.fishReel : snd?.activities[e.skill];
            sound.play(id);
          }
          for (const [i, n] of e.items.slice(0, 2)) float('player', `+${n} ${data.items[i]?.name ?? ''}`, 'loot', 'player');
          break;
      }
    });
    return () => { off(); d.dispose(); dio.current = null; };
  }, []);

  const ph = s.phase, a = s.action;
  const mob = ph.p === 'combat' ? ph.mob : null;
  const def = mob ? data.creatures[mob.id] : a?.kind === 'fight' ? data.creatures[a.creature] : null;
  // Mounting mid-fight (or after a reload): show the current mob without waiting for the next spawn.
  // Later spawns arrive as events, so this runs once.
  useEffect(() => { if (mob && def) dio.current?.setMob(def.displayIds, 0, def.equip); }, []);
  useEffect(() => { if (a?.kind !== 'fight') dio.current?.setMob(null); }, [a?.kind]);

  const look = s.char.look ?? { sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 };
  // While fishing or mining the character holds the pole or pick from their bags instead of weapons.
  const toolKind = a?.kind === 'fish' ? 'fishing-pole' : a?.kind === 'gather' && data.nodes[a.node]?.skill === 'mining' ? 'mining-pick' : null;
  const tool = toolKind ? [...SLOTS.map(sl => s.equipment[sl]), ...Object.keys(s.inventory).map(Number)]
    .map(id => (id ? data.items[id] : undefined)).find(it => it?.tool === toolKind && it.displayId) : undefined;
  const gear = SLOTS.flatMap(slot => {
    if (tool && (slot === 'mainhand' || slot === 'offhand')) return [];
    const it = s.equipment[slot] ? data.items[s.equipment[slot]!] : undefined;
    const glow = s.enchants?.[slot] ? data.enchants[s.enchants[slot]!]?.glow : undefined;
    return it?.displayId ? [{ displayId: it.displayId, invType: it.invType, slot, ...(glow ? { glow } : {}) }] : [];
  });
  if (tool) gear.push({ displayId: tool.displayId, invType: tool.invType, slot: 'mainhand' });
  useEffect(() => { dio.current?.setPlayer({ race: s.char.race, ...look }, gear); }, [s.char.race, JSON.stringify(look), JSON.stringify(gear)]);

  // Your pet stands beside you while you fight.
  const pet = a?.kind === 'fight' ? activePet(s) : null;
  const petDisplay = pet ? pet.displayId || (pet.creature ? data.creatures[pet.creature]?.displayIds[0] : 0) || null : null;
  useEffect(() => { dio.current?.setPet(petDisplay); }, [petDisplay]);
  useEffect(() => { if (pet && !pet.dead) dio.current?.revivePet(); }, [pet?.dead]);

  const recipe = a?.kind === 'craft' ? data.recipes[a.recipe] : undefined;
  const node = a?.kind === 'gather' ? data.nodes[a.node] : undefined;
  const prop = node ? node.displayId : a?.kind === 'fish' ? FISHING_BOBBER : recipe ? STATION[recipe.skill] ?? null : null;
  useEffect(() => { dio.current?.setProp(prop ?? null, { water: a?.kind === 'fish' }); }, [prop, a?.kind]);

  const activity: Activity = ph.p === 'dead' ? 'dead'
    : ph.p === 'rest' ? (ph.eating ? 'eat' : 'rest')
    : !a ? 'idle'
    : a.kind === 'fight' ? 'combat'
    : a.kind === 'gather' ? (node?.skill ?? 'mining')
    : a.kind === 'fish' ? 'fishing'
    : a.kind === 'travel' ? 'travel'
    : a.kind === 'quest' ? 'quest'
    : a.kind === 'dungeon' ? 'idle'
    : recipe?.skill === 'cooking' ? 'cooking'
    : recipe?.skill === 'blacksmithing' || recipe?.skill === 'mining' ? 'smithing'
    : recipe?.skill === 'enchanting' ? 'enchanting' : 'crafting';
  useEffect(() => { dio.current?.setActivity(activity); }, [activity]);

  const st = playerStats(s, data);
  const until = ph.p === 'work' ? ph.until : null;
  const banner = ph.p === 'search' ? 'Searching for a target…'
    : ph.p === 'rest' ? (ph.eating ? `Eating ${data.items[ph.eating.item]?.name}…` : 'Resting… (no food: 1 HP per minute)')
    : ph.p === 'dead' ? `You are dead. Resurrecting in ${fmtTime(ph.until - Date.now())}`
    : a?.kind === 'gather' && node ? `${node.skill === 'mining' ? 'Mining' : 'Gathering'} ${node.name}…`
    : a?.kind === 'fish' ? 'Fishing…'
    : a?.kind === 'craft' && recipe ? `${recipe.skill === 'cooking' ? 'Cooking' : 'Making'} ${recipe.name}…`
    : a?.kind === 'travel' ? `Travelling to ${data.zones.find(z => z.id === a.to)?.name}${until ? ` · ${fmtTime(Math.max(0, until - Date.now()))} left` : ''}`
    : a?.kind === 'quest' ? `${data.quests[a.quest]?.task?.label ?? 'Questing'}…`
    : a?.kind === 'dungeon' ? `In ${data.dungeons[a.dungeon]?.name} with your group · back in ${fmtTime(Math.max(0, a.until - Date.now()))}`
    : !a ? (hint ?? 'Idle') : '';
  return (
    <div className="diorama" ref={host}>
      <div className="hud">
        <div className="unitframe">
          <div className="uname"><span>{s.char.name}</span><span className="muted">{s.char.level}</span></div>
          <Bar kind="hp" value={s.char.hp} max={st.maxHp} label={`${Math.floor(s.char.hp)} / ${st.maxHp}`} />
          <PowerBar s={s} data={data} thin />
        </div>
        {mob && def && (
          <div className="unitframe">
            <div className="uname"><span>{def.name}</span><span className="muted">{mob.level}{def.rank ? '+' : ''}</span></div>
            <Bar kind="enemy" value={mob.hp} max={mob.maxHp} label={`${Math.max(0, mob.hp)} / ${mob.maxHp}`} />
          </div>
        )}
      </div>
      <div className="floaters">{floaters.map(f => <div key={f.id} className={`floater ${f.cls}`} style={{ left: f.x, top: f.y }}>{f.text}</div>)}</div>
      {banner && <div className="phase-banner">{banner}</div>}
    </div>
  );
}

// ================================================================ gathering (mining, herbalism)

export function GatherPage({ s, data, skill }: P & { skill: 'mining' | 'herbalism' }) {
  const zone = data.zones.find(z => z.id === s.zone)!;
  const sk = s.skills[skill];
  const nodes = zone.nodes.filter(n => data.nodes[n.id].skill === skill);
  const current = s.action?.kind === 'gather' ? s.action.node : null;
  return (
    <>
      <SkillHeader s={s} data={data} skill={skill} />
      <ActionScene s={s} data={data} hint={skill === 'mining' ? 'Pick a vein to mine' : 'Pick an herb to gather'} />
      <div className="grid">
        {nodes.map(({ id, spawns }) => {
          const n = data.nodes[id];
          const color = sk.max ? gatherColor(sk.level, n.reqSkill) : 'red';
          const err = canGather(s, data, id);
          const drops = topDrops(data, n.loot, 4);
          return (
            <div key={id} className={`card ${current === id ? 'current' : ''} ${color === 'red' ? 'locked' : ''}`}>
              <div className="row">
                {drops[0] && <ItemIcon id={drops[0][0]} data={data} size="lg" />}
                <div style={{ minWidth: 0 }}>
                  <div className={`title ${colorClass(color)}`}>{n.name}</div>
                  <div className="meta">Requires {SKILL_NAME[skill]} {n.reqSkill} · {spawns} in zone</div>
                </div>
              </div>
              <div className="row" style={{ gap: 4 }}>{drops.map(([i]) => <ItemIcon key={i} id={i} data={data} size="sm" />)}</div>
              {current === id && <WorkBar s={s} />}
              <div className="btn-row">
                {current === id
                  ? <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>
                  : <button className="btn" disabled={!!err} title={err ?? ''} onClick={() => game.command({ name: 'start', action: { kind: 'gather', node: id } })}>{skill === 'mining' ? 'Mine' : 'Gather'}</button>}
                {err && <span className="faint" style={{ fontSize: 12 }}>{err}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {skill === 'mining' && <CraftPage s={s} data={data} skill="mining" embedded />}
    </>
  );
}

// ================================================================ fishing

export function FishingPage({ s, data }: P) {
  const zone = data.zones.find(z => z.id === s.zone)!;
  const f = zone.fishing;
  const active = s.action?.kind === 'fish';
  const err = canFish(s, data);
  return (
    <>
      <SkillHeader s={s} data={data} skill="fishing" />
      <ActionScene s={s} data={data} hint="Cast a line below" />
      {f ? (
        <div className={`card ${active ? 'current' : ''}`} style={{ maxWidth: 560 }}>
          <div className="row"><Icon name="Trade_Fishing" size="lg" /><div>
            <div className="title">Fishing in {zone.name}</div>
            <div className="meta">Catch chance {fishingCatchChance(s.skills.fishing.level, f.zoneSkill).toFixed(0)}% · bobber waits 5-18s</div>
          </div></div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{topDrops(data, f.loot, 10).map(([i, p]) => (
            <span key={i} {...withTip(() => <><ItemTooltip item={data.items[i]} data={data} /><div className="t-muted">~{p.toFixed(p < 1 ? 2 : 0)}% of catches</div></>)}><ItemIcon id={i} data={data} /></span>))}</div>
          {active && <WorkBar s={s} />}
          <div className="btn-row">
            {active ? <button className="btn secondary" onClick={() => game.command({ name: 'stop' })}>Stop</button>
              : <button className="btn" disabled={!!err} onClick={() => game.command({ name: 'start', action: { kind: 'fish' } })}>Fish</button>}
            {err && <span className="faint" style={{ fontSize: 12 }}>{err}</span>}
          </div>
        </div>
      ) : <div className="panel muted">There's no fishing in this zone.</div>}
    </>
  );
}

// ================================================================ shared skill bits

export function SkillHeader({ s, data, skill }: P & { skill: Profession }) {
  const sk = s.skills[skill];
  const next = data.skillRanks[skill].find(r => r.max > sk.max);
  const terms = next && rankTerms(skill, next, sk.max);
  return (
    <div className="panel">
      <div className="panel-head" style={{ marginBottom: 8 }}>
        <Icon name={SKILL_ICON[skill]} size="lg" />
        <div><h2>{SKILL_NAME[skill]}</h2><div className="muted">{sk.max ? `${rankName(data, skill, sk.max)} · ${sk.level} / ${sk.max}` : 'Not trained'}{PRIMARY_PROFESSIONS.includes(skill) ? ' · primary' : ' · secondary'}</div></div>
        <span className="spacer" />
        {next && <button className="btn secondary" onClick={() => game.command({ name: 'train', skill })}>
          Train {next.name} {terms!.cost ? <Money copper={terms!.cost} /> : '(free)'}{terms!.reqLevel > s.char.level ? ` (level ${terms!.reqLevel})` : ''}</button>}
      </div>
      {sk.max > 0 && <Bar kind="xp" value={sk.level} max={sk.max} label={`${sk.level} / ${sk.max}`} />}
    </div>
  );
}

export function WorkBar({ s }: { s: GameState }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force(x => x + 1), 100); return () => clearInterval(t); }, []);
  const ph = s.phase;
  if (ph.p !== 'work') return <Bar kind="work" thin value={0} max={1} />;
  return <Bar kind="work" thin value={Date.now() - ph.from} max={ph.until - ph.from} />;
}

export const SKILL_ICON: Record<Profession, string> = {
  mining: 'Trade_Mining', herbalism: 'INV_Misc_Flower_02', skinning: 'INV_Misc_Pelt_Wolf_01', fishing: 'Trade_Fishing',
  cooking: 'INV_Misc_Food_15', firstaid: 'Spell_Holy_SealOfSacrifice', alchemy: 'Trade_Alchemy',
  blacksmithing: 'Trade_BlackSmithing', enchanting: 'Trade_Engraving', engineering: 'Trade_Engineering',
  leatherworking: 'INV_Misc_ArmorKit_17', tailoring: 'Trade_Tailoring',
};
const rankName = (data: GameData, skill: Profession, max: number) => data.skillRanks[skill].find(r => r.max === max)?.name ?? '';
const cap = (x: string) => x[0].toUpperCase() + x.slice(1);

// ================================================================ character: equipment + bags

const SLOT_ICON: Record<Slot, string> = {
  head: 'head', neck: 'neck', shoulders: 'shoulder', back: 'chest', chest: 'chest', wrist: 'wrists', hands: 'hands',
  waist: 'waist', legs: 'legs', feet: 'feet', finger1: 'finger', finger2: 'rfinger', trinket1: 'trinket', trinket2: 'trinket',
  mainhand: 'mainhand', offhand: 'secondaryhand', ranged: 'ranged',
};
const LEFT: Slot[] = ['head', 'neck', 'shoulders', 'back', 'chest', 'wrist'];
const RIGHT: Slot[] = ['hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2'];
const BOTTOM: Slot[] = ['mainhand', 'offhand', 'ranged'];
void SLOTS;

export function CharacterPage({ s, data }: P) {
  const st = playerStats(s, data);
  const race = data.races.find(r => r.id === s.char.race)?.name, cls = data.classes.find(c => c.id === s.char.cls)?.name;
  const slot = (sl: Slot) => {
    const id = s.equipment[sl];
    return (
      <div key={sl} className="eqslot" style={id ? undefined : { backgroundImage: `url(ui/ui-paperdoll-slot-${SLOT_ICON[sl]}.png)` }}
        onClick={() => id && game.command({ name: 'unequip', slot: sl })} title={id ? 'Click to unequip' : sl}>
        {id ? <ItemIcon id={id} data={data} /> : null}
      </div>
    );
  };
  return (
    <>
      <div className="panel-head"><h2>{s.char.name}</h2><span className="muted">Level {s.char.level} {race} {cls}</span></div>
      <div className="panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 24 }}>
        <div>
          <div className="paperdoll">
            <div className="col">{LEFT.map(slot)}</div>
            <div className="col" style={{ justifyContent: 'flex-end' }}><div className="btn-row" style={{ justifyContent: 'center' }}>{BOTTOM.map(slot)}</div></div>
            <div className="col">{RIGHT.map(slot)}</div>
          </div>
        </div>
        <div className="stats">
          <span className="k">Health</span><span className="v">{Math.floor(s.char.hp)} / {st.maxHp}</span>
          <span className="k">Strength</span><span className="v">{st.str}</span>
          <span className="k">Agility</span><span className="v">{st.agi}</span>
          <span className="k">Stamina</span><span className="v">{st.sta}</span>
          <span className="k">Intellect</span><span className="v">{st.int}</span>
          <span className="k">Spirit</span><span className="v">{st.spi}</span>
          <span className="k">Armor</span><span className="v">{st.armor}</span>
          <span className="k">Attack Power</span><span className="v">{st.ap}</span>
          <span className="k">Damage</span><span className="v">{st.dmgMin} - {st.dmgMax}</span>
          <span className="k">Speed</span><span className="v">{(st.speedMs / 1000).toFixed(2)}</span>
          <span className="k">Crit</span><span className="v">{st.crit.toFixed(1)}%</span>
          <span className="k">Dodge</span><span className="v">{st.dodge.toFixed(1)}%</span>
          {st.maxMana > 0 && <><span className="k">Mana</span><span className="v">{st.maxMana}</span>
            <span className="k">Spell crit</span><span className="v">{st.spellCrit.toFixed(1)}%</span></>}
          <span className="k" style={{ gridColumn: '1 / -1', marginTop: 8, color: 'var(--gold)' }}>Weapon skills</span>
          {Object.entries(s.combatSkills).map(([id, v]) => <span key={id} style={{ display: 'contents' }}>
            <span className="k">{data.skillNames?.[+id] ?? `Skill ${id}`}</span><span className="v">{v} / {s.char.level * 5}</span></span>)}
        </div>
      </div>
      <BagsPanel s={s} data={data} />
    </>
  );
}

export function BagsPanel({ s, data }: P) {
  const [sel, setSel] = useState<number | null>(null);
  const items = Object.entries(s.inventory).map(([id, n]) => [Number(id), n] as [number, number])
    .filter(([id]) => data.items[id])
    .sort((a, b) => data.items[b[0]].quality - data.items[a[0]].quality || data.items[a[0]].name.localeCompare(data.items[b[0]].name));
  const it = sel !== null ? data.items[sel] : null;
  const count = sel !== null ? s.inventory[sel] ?? 0 : 0;
  const junkValue = items.filter(([id]) => data.items[id].quality === 0).reduce((a, [id, n]) => a + data.items[id].sellPrice * n, 0);
  const { bar, groups } = useItemFilter(data, items.map(([id]) => id));
  const space = bagSpace(s, data);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Bags</h3><span className={space.used >= space.total ? 'bad' : 'muted'}>{space.used}/{space.total} slots{space.special.map((b, i) => ` · ${b.used}/${b.slots} ${b.family & 3 ? 'ammo' : 'special'}`).join('')}</span><span className="spacer" />
        {junkValue > 0 && <button className="btn secondary small" onClick={() => game.command({ name: 'sellJunk' })}>Sell junk (<Money copper={junkValue} />)</button>}</div>
      <div className="bag-slots">{[0, 1, 2, 3].map(i => {
        const id = s.bags?.[i];
        return id ? (
          <div key={i} className="slot" title="Take off" onClick={() => game.command({ name: 'unequipBag', slot: i })}
            {...withTip(() => <><ItemTooltip item={data.items[id]} data={data} /><div className="t-muted">{data.items[id]?.bagSlots} slots · click to take off</div></>)}><ItemIcon id={id} data={data} /></div>
        ) : <div key={i} className="slot empty" title="Empty bag slot: equip a bag from your bags" />;
      })}{space.used >= space.total && <span className="bad" style={{ fontSize: 12 }}>{s.settings.autoDeposit ? 'Your bags are full: new loot goes to your bank.' : 'Your bags are full: loot is left behind and gathering stops.'}</span>}</div>
      {items.length > 0 && bar}
      {groups.map(([cat, ids]) => (
        <div key={cat}>
          <div className="cat-head">{cat}</div>
          <div className="bag">{ids.map(id => (
            <div key={id} className={`slot ${sel === id ? 'sel' : ''}`} onClick={() => setSel(sel === id ? null : id)}
              {...withTip(() => <ItemTooltip item={data.items[id]} data={data} count={s.inventory[id]} />)}>
              <ItemIcon id={id} data={data} count={s.inventory[id]} /></div>))}</div>
        </div>
      ))}
      {!items.length && <span className="muted">Your bags are empty.</span>}
      {items.length > 0 && !groups.length && <span className="muted">Nothing matches.</span>}
      {it && count > 0 && (
        <div className="card" style={{ marginTop: 12, maxWidth: 520 }}>
          <div className="row"><ItemIcon id={it.id} data={data} size="lg" /><div><div className={`title q${it.quality}`}>{it.name}</div><div className="meta">You have {count}</div></div></div>
          <div className="btn-row">
            {(equipSlots(it).length > 0 || !!it.bagSlots) && <button className="btn" onClick={() => { game.command({ name: 'equip', item: it.id }); setSel(null); }}>{it.bagSlots ? `Equip bag (${it.bagSlots} slots)` : 'Equip'}</button>}
            {it.sellPrice > 0 && <button className="btn secondary" onClick={() => game.command({ name: 'sell', item: it.id, count: 1 })}>Sell 1 (<Money copper={it.sellPrice} />)</button>}
            {it.sellPrice > 0 && count > 1 && <button className="btn secondary" onClick={() => { game.command({ name: 'sell', item: it.id, count: count }); setSel(null); }}>Sell all (<Money copper={it.sellPrice * count} />)</button>}
            <button className="btn secondary" onClick={() => { game.command({ name: 'bankDeposit', item: it.id, count }); setSel(null); }}>Put in bank</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================ town: trainers + vendors

export function TownPage({ s, data }: P) {
  const zone = data.zones.find(z => z.id === s.zone)!;
  const faction = factionOfRace(data, s.char.race);
  const seen = new Set<number>();
  const offers = zone.vendorItems.filter(v => data.items[v.item] && v.factions.includes(faction) && !seen.has(v.item) && seen.add(v.item));
  const vendorOf = new Map(offers.map(v => [v.item, v.vendor]));
  const { bar, groups } = useItemFilter(data, offers.map(v => v.item));
  return (
    <>
      <div className="panel-head"><h2>Trainers & Vendors</h2><span className="muted">{zone.name}</span></div>
      <div className="panel">
        <div className="panel-head"><h3>Profession trainers</h3><span className="spacer" />
          <span className="muted">Primary professions: {PRIMARY_PROFESSIONS.filter(p => s.skills[p]?.max).length} / {MAX_PRIMARY}</span></div>
        <div className="grid">
          {PROFESSIONS.map(skill => {
            const sk = s.skills[skill];
            const next = data.skillRanks[skill].find(r => r.max > sk.max);
            return (
              <div key={skill} className="card">
                <div className="row"><Icon name={SKILL_ICON[skill]} /><div><div className="title">{SKILL_NAME[skill]}</div>
                  <div className="meta">{sk.max ? `${sk.level} / ${sk.max}` : 'Not trained'}{PRIMARY_PROFESSIONS.includes(skill) ? '' : ' · secondary'}</div></div></div>
                {next ? <button className="btn secondary" onClick={() => game.command({ name: 'train', skill })}>
                  {next.name} ({next.max}) {rankTerms(skill, next, sk.max).cost ? <Money copper={rankTerms(skill, next, sk.max).cost} /> : 'free'}{rankTerms(skill, next, sk.max).reqLevel > s.char.level ? ` · lvl ${rankTerms(skill, next, sk.max).reqLevel}` : ''}</button>
                  : <span className="muted">Max rank</span>}
                {sk.max > 0 && <button className="btn secondary small" onClick={() => confirm(`Unlearn ${SKILL_NAME[skill]}? Your skill and recipes are lost.`) && game.command({ name: 'unlearn', skill })}>Unlearn</button>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Vendors</h3><span className="muted">{offers.length} items for sale in {zone.name}</span></div>
        {offers.length ? bar : <p className="muted" style={{ margin: 0 }}>No vendor here will trade with you.</p>}
        {groups.map(([cat, ids]) => (
          <div key={cat}>
            <div className="cat-head">{cat}</div>
            <div className="grid">
              {ids.map(item => {
                const it = data.items[item];
                return (
                  <div key={item} className="card">
                    <div className="row"><span {...withTip(() => <ItemTooltip item={it} data={data} />)}><ItemIcon id={item} data={data} /></span><div style={{ minWidth: 0 }}><div className={`title q${it.quality}`}>{it.name}</div><div className="meta">{vendorOf.get(item)}{it.reqRep && data.factions[it.reqRep[0]] ? ` · needs ${REP_RANKS[it.reqRep[1]]} with ${data.factions[it.reqRep[0]].name}` : ''}</div></div></div>
                    <div className="btn-row"><button className="btn secondary small" onClick={() => game.command({ name: 'buy', item, count: 1 })}>Buy <Money copper={it.buyPrice} /></button>
                      {it.stack > 1 && <button className="btn secondary small" onClick={() => game.command({ name: 'buy', item, count: 5 })}>x5 <Money copper={it.buyPrice * 5} /></button>}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Your own bank: 200 stacks, open anywhere; with auto-deposit on, what your bags can't hold goes here. */
export function BankPanel({ s, data }: P) {
  const [sel, setSel] = useState<number | null>(null);
  const items = Object.entries(s.bank ?? {}).map(([id, n]) => [Number(id), n] as [number, number]).filter(([id]) => data.items[id])
    .sort((a, b) => data.items[b[0]].quality - data.items[a[0]].quality || data.items[a[0]].name.localeCompare(data.items[b[0]].name));
  const { bar, groups } = useItemFilter(data, items.map(([id]) => id));
  const used = bankUsed(s, data);
  const it = sel !== null ? data.items[sel] : null;
  const count = sel !== null ? s.bank?.[sel] ?? 0 : 0;
  const room = it ? Math.min(count, roomFor(s, data, it.id)) : 0;
  return (
    <div className="panel">
      <div className="panel-head"><h3>Bank</h3><span className={used >= BANK_SLOTS ? 'bad' : 'muted'}>{used}/{BANK_SLOTS} slots</span><span className="spacer" />
        <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={!!s.settings.autoDeposit}
          onChange={e => game.command({ name: 'settings', autoDeposit: e.target.checked })} /> Auto-deposit when bags are full</label>
        <button className="btn secondary small" onClick={() => game.command({ name: 'bankDepositAll' })} title="Keeps tools, food, potions, ammo and bags">Deposit materials</button></div>
      {items.length > 0 && bar}
      {groups.map(([cat, ids]) => (
        <div key={cat}>
          <div className="cat-head">{cat}</div>
          <div className="bag">{ids.map(id => (
            <div key={id} className={`slot ${sel === id ? 'sel' : ''}`} onClick={() => setSel(sel === id ? null : id)}>
              <ItemIcon id={id} data={data} count={s.bank?.[id]} /></div>))}</div>
        </div>
      ))}
      {!items.length && <span className="muted">Your bank is empty. Materials go here automatically when your bags are full.</span>}
      {it && count > 0 && (
        <div className="card" style={{ marginTop: 12, maxWidth: 520 }}>
          <div className="row"><ItemIcon id={it.id} data={data} size="lg" /><div><div className={`title q${it.quality}`}>{it.name}</div><div className="meta">{count} in the bank</div></div></div>
          <div className="btn-row">
            <button className="btn" disabled={!room} onClick={() => game.command({ name: 'bankWithdraw', item: it.id, count: 1 })}>Take 1</button>
            <button className="btn secondary" disabled={!room} onClick={() => { game.command({ name: 'bankWithdraw', item: it.id, count: room }); if (room === count) setSel(null); }}>
              {room < count ? `Take ${room} (bags full)` : 'Take all'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================ log + settings

const SOUND_SLIDERS: [keyof SoundSettings, string][] = [['master', 'Master'], ['effects', 'Effects'], ['voices', 'Creature voices'], ['music', 'Music'], ['ambience', 'Ambience']];

/** Volumes, kept per browser (sound comes from your own client, converted the first time it plays). */
function SoundPanel() {
  const st = useSyncExternalStore(sound.subscribe, sound.getSettings);
  return (
    <div className="panel"><div className="panel-head"><h3>Sound</h3><span className="spacer" />
      <label><input type="checkbox" checked={st.muted} onChange={e => sound.set({ muted: e.target.checked })} /> Mute</label></div>
      <div className="sound-sliders">
        {SOUND_SLIDERS.map(([k, label]) => (
          <label key={k} className="muted">{label}
            <input type="range" min={0} max={1} step={0.05} value={st[k] as number} disabled={st.muted}
              onChange={e => sound.set({ [k]: +e.target.value } as Partial<SoundSettings>)} />
            <span className="faint">{Math.round((st[k] as number) * 100)}%</span></label>))}
      </div>
    </div>
  );
}

export function LogPage({ s }: P) {
  return (
    <>
      <div className="panel"><div className="panel-head"><h3>Activity log</h3></div>
        <div className="log">{[...s.log].reverse().map((l, i) => <div key={i} className={l.kind}><span className="faint">{new Date(l.t).toLocaleTimeString()}</span> {l.text}</div>)}</div></div>
      <div className="panel"><div className="panel-head"><h3>Settings</h3></div>
        <div className="btn-row">
          <label className="muted">Rest between fights below <input type="number" min={10} max={99} value={s.settings.restBelowPct} style={{ width: 52 }}
            onChange={e => game.command({ name: 'settings', restBelowPct: Math.max(10, Math.min(99, +e.target.value || 60)) })} />% health</label>
          <label><input type="checkbox" checked={s.settings.autoEat} onChange={e => game.command({ name: 'settings', autoEat: e.target.checked })} /> Eat food while resting</label>
        </div>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
          Health only comes back on its own at 1 point per minute. Food from fishing, cooking and vendors is how you recover;
          without it you'll wait a long time between fights.
        </p>
      </div>
      <SoundPanel />
      <div className="panel"><div className="panel-head"><h3>Account</h3></div>
        <p className="muted" style={{ marginTop: 0 }}>
          Logged in as <b>{game.account?.username}</b> on {game.serverUrl}. Your character lives on the guild server and keeps
          progressing for up to 24 hours after you were last online.
        </p>
        <div className="btn-row"><button className="btn secondary" onClick={() => game.logout()}>Log out</button></div>
      </div>
    </>
  );
}
