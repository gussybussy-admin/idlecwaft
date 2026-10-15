// Character (player race) models and humanoid NPC appearances.
//
// Characters are assembled at runtime in the client: one model per race/sex with every geoset,
// plus the CharSections texture pieces (skin, face, facial hair, scalp, underwear, hair) that the
// client composites into the 256x256 body texture. Humanoid NPCs ship a pre-baked body texture.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { decodeBLP } from '../blp/blp.js';
import { encodePNG } from '../img/png.js';
import { parseM2 } from '../m2/m2.js';
import { m2ToGLB } from '../gltf/m2-to-glb.js';

export const RACE_DIRS: Record<number, string> = {
  1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'NightElf', 5: 'Scourge', 6: 'Tauren', 7: 'Gnome', 8: 'Troll',
};
const SEX_DIRS = ['Male', 'Female'];

/** Character animations the game uses (combat, gathering, eating, fishing, casting). The rest are emotes. */
export const CHARACTER_ANIMATIONS = new Set([
  'Stand', 'Walk', 'Run', 'Death', 'StandWound', 'Stun',
  'ReadyUnarmed', 'Ready1H', 'Ready2H', 'Ready2HL', 'AttackUnarmed', 'Attack1H', 'Attack1HPierce', 'Attack2H', 'Attack2HL',
  'ParryUnarmed', 'Parry1H', 'Dodge', 'CombatWound', 'CombatCritical',
  'Loot', 'KneelStart', 'KneelLoop', 'KneelEnd', 'EmoteWork', 'EmoteWorkNoSheathe', 'FishingCast', 'FishingLoop',
  'UseStandingStart', 'UseStandingLoop', 'UseStandingEnd', 'EmoteEat', 'EmoteEatNoSheathe', 'SitGround', 'SitGroundDown', 'SitGroundUp',
  'SpellCastDirected', 'SpellCastOmni', 'ReadySpellDirected', 'ChannelCastDirected', 'EmoteCheer',
]);

export interface CharSection { race: number; sex: number; type: number; variation: number; color: number; tex: string[] }
export interface CharacterIndex {
  models: Record<string, string>; // "race:sex" -> glb path
  sections: CharSection[];
  hair: { race: number; sex: number; variation: number; geoset: number; showScalp: boolean }[];
  facial: { race: number; sex: number; variation: number; g1: number; g2: number; g3: number }[];
}

export interface Humanoid {
  race: number; sex: number; skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number;
  bake: string | null;               // baked body texture (PNG path in the cache)
  geosets: Record<number, number>;   // group -> submesh id overrides from equipped items
}

const texPath = (blp: string) => `character/tex/${blp.replace(/\\/g, '/').replace(/\.blp$/i, '').toLowerCase()}.png`;

function writeTexture(client: Client, cacheDir: string, blp: string): string | null {
  const rel = texPath(blp), out = path.join(cacheDir, rel);
  if (fs.existsSync(out)) return rel;
  const buf = client.archives.read(blp);
  if (!buf) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(decodeBLP(buf)));
  return rel;
}

export function convertCharacters(client: Client, cacheDir: string, races: number[], log: (s: string) => void = () => {}): CharacterIndex {
  const index: CharacterIndex = { models: {}, sections: [], hair: [], facial: [] };
  const names = client.animationNames();
  for (const race of races) for (const sex of [0, 1]) {
    const file = `Character\\${RACE_DIRS[race]}\\${SEX_DIRS[sex]}\\${RACE_DIRS[race]}${SEX_DIRS[sex]}.m2`;
    const buf = client.archives.read(file);
    if (!buf) { log(`missing ${file}`); continue; }
    const m = parseM2(buf);
    // All textures here are runtime-assigned (types 1, 2, 6, 8): export untextured, the client paints them.
    const glb = m2ToGLB(m, { name: `${RACE_DIRS[race]}${SEX_DIRS[sex]}`, animationNames: names, resolveTexture: () => null,
      keepAnimation: n => CHARACTER_ANIMATIONS.has(n) });
    const rel = `character/${RACE_DIRS[race].toLowerCase()}${SEX_DIRS[sex].toLowerCase()}.glb`;
    fs.mkdirSync(path.join(cacheDir, 'character'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, rel), glb);
    index.models[`${race}:${sex}`] = rel;
  }

  const cs = client.dbc('CharSections'); // 1 race, 2 sex, 3 type, 4 variation, 5 color, 6-8 textures
  for (const r of cs.rows()) {
    const race = cs.u32(r, 1);
    if (!races.includes(race)) continue;
    const tex = [6, 7, 8].map(f => cs.str(r, f)).map(t => (t ? writeTexture(client, cacheDir, t) ?? '' : ''));
    index.sections.push({ race, sex: cs.u32(r, 2), type: cs.u32(r, 3), variation: cs.u32(r, 4), color: cs.u32(r, 5), tex });
  }
  const hg = client.dbc('CharHairGeosets'); // 1 race, 2 sex, 3 variation, 4 geoset, 5 showScalp
  for (const r of hg.rows()) if (races.includes(hg.u32(r, 1))) {
    index.hair.push({ race: hg.u32(r, 1), sex: hg.u32(r, 2), variation: hg.u32(r, 3), geoset: hg.u32(r, 4), showScalp: !!hg.u32(r, 5) });
  }
  const fh = client.dbc('CharacterFacialHairStyles'); // 0 race, 1 sex, 2 variation, 6 geoset100, 7 geoset300, 8 geoset200
  for (const r of fh.rows()) if (races.includes(fh.u32(r, 0))) {
    index.facial.push({ race: fh.u32(r, 0), sex: fh.u32(r, 1), variation: fh.u32(r, 2), g1: fh.u32(r, 6), g3: fh.u32(r, 7), g2: fh.u32(r, 8) });
  }
  fs.writeFileSync(path.join(cacheDir, 'character/index.json'), JSON.stringify(index));
  log(`characters: ${Object.keys(index.models).length} models, ${index.sections.length} appearance sections`);
  return index;
}

// NPC item display slots in CreatureDisplayInfoExtra (fields 8-17).
const NPC_SLOTS = ['head', 'shoulder', 'shirt', 'chest', 'belt', 'legs', 'boots', 'wrist', 'gloves', 'tabard'] as const;

/**
 * Appearance of a humanoid NPC (CreatureDisplayInfoExtra): race, look, baked body texture, and the
 * geoset changes its equipped items make (sleeves, gloves, boots, robes, tabard).
 */
export function humanoidFor(client: Client, extraId: number, cacheDir: string): Humanoid | null {
  const ex = client.dbc('CreatureDisplayInfoExtra');
  const r = ex.rows().find(i => ex.u32(i, 0) === extraId);
  if (r === undefined) return null;
  const idi = client.dbc('ItemDisplayInfo'); // 6-8 geoset groups
  const geo = new Map(idi.rows().map(i => [idi.u32(i, 0), [idi.u32(i, 6), idi.u32(i, 7), idi.u32(i, 8)]]));
  const items = Object.fromEntries(NPC_SLOTS.map((s, i) => [s, ex.u32(r, 8 + i)])) as Record<typeof NPC_SLOTS[number], number>;
  const g = (slot: keyof typeof items) => geo.get(items[slot]) ?? [0, 0, 0];
  const geosets: Record<number, number> = {};
  if (items.gloves) geosets[4] = 401 + g('gloves')[0];
  if (items.boots) geosets[5] = 501 + g('boots')[0];
  if (items.shirt) geosets[8] = 801 + g('shirt')[0];
  if (items.chest) { geosets[8] = 801 + g('chest')[0]; if (g('chest')[2]) geosets[13] = 1301 + g('chest')[2]; }
  if (items.legs) { geosets[9] = 901 + g('legs')[0]; if (g('legs')[2]) geosets[13] = 1301 + g('legs')[2]; }
  if (items.tabard) geosets[12] = 1202;
  const bakeName = ex.str(r, 18);
  const bake = bakeName ? writeTexture(client, cacheDir, `Textures\\BakedNpcTextures\\${bakeName}`) : null;
  return {
    race: ex.u32(r, 1), sex: ex.u32(r, 2), skin: ex.u32(r, 3), face: ex.u32(r, 4),
    hairStyle: ex.u32(r, 5), hairColor: ex.u32(r, 6), facialHair: ex.u32(r, 7), bake, geosets,
  };
}
