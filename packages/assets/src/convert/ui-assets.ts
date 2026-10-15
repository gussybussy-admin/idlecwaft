// Exports the UI art, fonts and scenery the game client uses, from the player's own client.
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '../client.js';
import { decodeBLP } from '../blp/blp.js';
import { encodePNG } from '../img/png.js';
import { parseM2 } from '../m2/m2.js';
import { m2ToGLB } from '../gltf/m2-to-glb.js';

export const FONTS = ['Fonts\\FRIZQT__.TTF', 'Fonts\\MORPHEUS.TTF'];

export const UI_TEXTURES = [
  'Interface\\TargetingFrame\\UI-StatusBar',
  'Interface\\DialogFrame\\UI-DialogBox-Background',
  'Interface\\DialogFrame\\UI-DialogBox-Gold-Background',
  'Interface\\Tooltips\\UI-Tooltip-Background',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Head', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Neck',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Shoulder', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Chest',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Waist', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Legs',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Feet', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Wrists',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Hands', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Finger',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-RFinger', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Trinket',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-MainHand', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-SecondaryHand',
  'Interface\\PaperDoll\\UI-PaperDoll-Slot-Ranged', 'Interface\\PaperDoll\\UI-PaperDoll-Slot-Rear',
];

/** Icons the UI itself uses (skills, nav), on top of every item icon in the game data. */
export const UI_ICONS = [
  'Ability_Warrior_OffensiveStance', 'Ability_DualWield', 'Trade_Mining', 'INV_Misc_Flower_02', 'Trade_Fishing',
  'INV_Misc_Food_15', 'INV_Misc_Bag_08', 'INV_Chest_Chain', 'INV_Misc_Note_01', 'INV_Misc_Coin_01',
  'INV_Misc_Coin_03', 'INV_Misc_Coin_05', 'Spell_Holy_Resurrection', 'INV_Misc_Bag_10', 'Spell_Nature_Sleep',
  'INV_Misc_Book_09', 'INV_Pick_02', 'INV_Fishingpole_02', 'Spell_Holy_Heal', 'Racial_Dwarf_FindTreasure',
];

export const TILESETS = ['Tileset\\Elwynn\\ElwynnGrassBase', 'Tileset\\Elwynn\\ElwynnDirtBase', 'Tileset\\Elwynn\\ElwynnFlowerBase'];

export const DOODADS = [
  'World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTreeCanopy01.m2',
  'World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTreeCanopy03.m2',
  'World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnFirTree01.m2',
  'World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\Stumps\\ElwynnTreeStump01.m2',
];

const slug = (p: string) => path.win32.basename(p).replace(/\.[^.]+$/, '').toLowerCase();

export function convertUiAssets(client: Client, cacheDir: string, log: (s: string) => void = () => {}): void {
  const dirs = { fonts: 'fonts', ui: 'ui', tiles: 'tiles', doodads: 'doodads' };
  for (const d of Object.values(dirs)) fs.mkdirSync(path.join(cacheDir, d), { recursive: true });

  for (const f of FONTS) {
    const buf = client.archives.read(f);
    if (buf) fs.writeFileSync(path.join(cacheDir, dirs.fonts, slug(f) + '.ttf'), buf);
  }
  let n = 0;
  for (const t of [...UI_TEXTURES.map(t => [t, dirs.ui]), ...TILESETS.map(t => [t, dirs.tiles])]) {
    const buf = client.archives.read(t[0] + '.blp');
    if (!buf) { log(`missing texture ${t[0]}`); continue; }
    fs.writeFileSync(path.join(cacheDir, t[1], slug(t[0]) + '.png'), encodePNG(decodeBLP(buf)));
    n++;
  }
  const names = client.animationNames();
  for (const d of DOODADS) {
    const buf = client.archives.read(d);
    if (!buf) { log(`missing doodad ${d}`); continue; }
    const m = parseM2(buf);
    const glb = m2ToGLB(m, {
      name: slug(d), animationNames: names,
      resolveTexture: slot => {
        const file = m.textures[slot]?.filename;
        const tex = file ? client.archives.read(file) : null;
        return tex ? { image: decodeBLP(tex), name: path.win32.basename(file) } : null;
      },
    });
    fs.writeFileSync(path.join(cacheDir, dirs.doodads, slug(d) + '.glb'), glb);
    n++;
  }
  log(`ui assets: ${FONTS.length} fonts, ${n} textures/doodads`);
}
