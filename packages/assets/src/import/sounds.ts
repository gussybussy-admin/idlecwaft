// Which sound plays where: SoundEntries ids attached to zones (music, ambience), creatures (voices),
// spells and recipes (cast and impact), plus interface, gathering and weapon impact sounds. Only ids go
// into the game data; the audio itself is converted from each player's own client on first use.
import type { GameData, GameSounds } from '@idle/sim';
import type { Client } from '../client.js';

/** Interface sounds, by their SoundEntries name. */
const UI: Record<string, string> = {
  levelUp: 'LEVELUP', questAdded: 'QUESTADDED', questComplete: 'QUESTCOMPLETED', questFailed: 'igQuestFailed',
  coins: 'LOOTWINDOWCOINSOUND', bag: 'igBackPackOpen', tab: 'igCharacterInfoTab', spellbook: 'igSpellBookOpen',
  menuOpen: 'igMainMenuOpen', menuClose: 'igMainMenuClose', eat: 'Item - Eat', select: 'igCreatureAggroSelect',
  reputation: 'ReputationLevelUp',
};
/**
 * Gathering and crafting, by SoundEntries name (the gathering spells' own visuals only carry a generic
 * cast sound; the pick, the herb rustle and the reel are played by animation events).
 */
const ACTIVITIES: Record<string, string> = {
  mining: 'Gather_Mining', herbalism: 'Gather_Herb', skinning: 'Skinning', fishing: 'Fishing Cast',
  fishHooked: 'Fishing Hooked', fishReel: 'Fishing Reel in', alchemy: 'Trade_Brew_Potion', tailoring: 'Item - Crinkling Paper',
  smelting: 'TradeSkill - Smelt', cooking: 'TradeSkill - Smelt',
};
/** Spell.dbc: SpellVisual id. */
const SPELL_VISUAL = 117;

export function attachSounds(client: Client, data: GameData): void {
  const se = client.dbc('SoundEntries');
  const sounds = new Set(se.rows().map(r => se.u32(r, 0)));
  const byName = new Map<string, number>();
  for (const r of se.rows()) if (!byName.has(se.str(r, 2))) byName.set(se.str(r, 2), se.u32(r, 0));
  const ok = (id: number) => (id && sounds.has(id) ? id : 0);

  // ---- zones: AreaTable 7 ambience (SoundAmbience: 1 day, 2 night), 8 music (ZoneMusic: 6 day, 7 night)
  const at = client.dbc('AreaTable'), zm = client.dbc('ZoneMusic'), sa = client.dbc('SoundAmbience');
  const area = new Map(at.rows().map(r => [at.u32(r, 0), r]));
  const music = new Map(zm.rows().map(r => [zm.u32(r, 0), [ok(zm.u32(r, 6)), ok(zm.u32(r, 7))] as [number, number]]));
  const amb = new Map(sa.rows().map(r => [sa.u32(r, 0), [ok(sa.u32(r, 1)), ok(sa.u32(r, 2))] as [number, number]]));
  for (const z of data.zones) {
    const r = area.get(z.id);
    if (r === undefined) continue;
    const m = music.get(at.u32(r, 8)), a = amb.get(at.u32(r, 7));
    const s: NonNullable<typeof z.sound> = {};
    if (m && (m[0] || m[1])) s.music = [m[0] || m[1], m[1] || m[0]];
    if (a && (a[0] || a[1])) s.ambience = [a[0] || a[1], a[1] || a[0]];
    if (s.music || s.ambience) z.sound = s;
  }

  // ---- creatures: CreatureDisplayInfo 2 (or its model's CreatureModelData 13) -> CreatureSoundData
  // (1 exertion, 3 injury, 6 death, 10 aggro)
  const cdi = client.dbc('CreatureDisplayInfo'), cmd = client.dbc('CreatureModelData'), csd = client.dbc('CreatureSoundData');
  const modelSound = new Map(cmd.rows().map(r => [cmd.u32(r, 0), cmd.u32(r, 13)]));
  const displaySound = new Map(cdi.rows().map(r => [cdi.u32(r, 0), cdi.u32(r, 2) || modelSound.get(cdi.u32(r, 1)) || 0]));
  const soundData = new Map(csd.rows().map(r => [csd.u32(r, 0), r]));
  for (const c of Object.values(data.creatures)) {
    const r = c.displayIds.map(d => soundData.get(displaySound.get(d) ?? 0)).find(x => x !== undefined);
    if (r === undefined) continue;
    const s = { aggro: ok(csd.u32(r, 10)), wound: ok(csd.u32(r, 3)), death: ok(csd.u32(r, 6)), attack: ok(csd.u32(r, 1)) };
    const kept = Object.fromEntries(Object.entries(s).filter(([, v]) => v));
    if (Object.keys(kept).length) c.sounds = kept;
  }

  // ---- spells: Spell -> SpellVisual (1 precast kit, 2 cast kit, 3 impact kit) -> SpellVisualKit 13 sound
  const spell = client.dbc('Spell'), sv = client.dbc('SpellVisual'), svk = client.dbc('SpellVisualKit');
  const kitSound = new Map(svk.rows().map(r => [svk.u32(r, 0), ok(svk.u32(r, 13))]));
  const visuals = new Map(sv.rows().map(r => [sv.u32(r, 0), r]));
  const spellRow = new Map(spell.rows().map(r => [spell.u32(r, 0), r]));
  const spellSound = (id: number): { cast?: number; impact?: number } | undefined => {
    const r = spellRow.get(id);
    const v = r === undefined ? undefined : visuals.get(spell.u32(r, SPELL_VISUAL));
    if (v === undefined) return undefined;
    const cast = kitSound.get(sv.u32(v, 2)) || kitSound.get(sv.u32(v, 1)) || 0;
    const impact = kitSound.get(sv.u32(v, 3)) || 0;
    if (!cast && !impact) return undefined;
    return { ...(cast ? { cast } : {}), ...(impact ? { impact } : {}) };
  };
  for (const s of Object.values(data.spells)) { const x = spellSound(s.id); if (x) s.sound = x; }
  for (const r of Object.values(data.recipes)) { const x = spellSound(r.spellId); if (x) r.sound = x.cast ?? x.impact; }
  for (const c of Object.values(data.creatures)) for (const a of c.abilities ?? []) { const x = spellSound(a.spell); if (x) a.sound = x.impact ?? x.cast; }

  // ---- interface, gathering, weapon impacts (WeaponImpactSounds: 1 weapon subclass, 3 hit, 13 crit)
  const ui: Record<string, number> = {};
  for (const [k, n] of Object.entries(UI)) { const id = byName.get(n); if (id) ui[k] = id; }
  const activities: Record<string, number> = {};
  for (const [k, n] of Object.entries(ACTIVITIES)) { const id = byName.get(n); if (id) activities[k] = id; }
  const wis = client.dbc('WeaponImpactSounds');
  const weapons: GameSounds['weapons'] = {};
  for (const r of wis.rows()) {
    const hit = ok(wis.u32(r, 3)), crit = ok(wis.u32(r, 13)) || hit;
    if (hit && !weapons[wis.u32(r, 1)]) weapons[wis.u32(r, 1)] = { hit, crit };
  }
  if (!weapons[-1] && weapons[13]) weapons[-1] = weapons[13]; // unarmed: like fist weapons
  data.sounds = { ui, activities, weapons };
}
