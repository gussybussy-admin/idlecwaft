// Converts the art the game client needs up front, from the player's own client: UI art, fonts,
// scenery, character models + appearance textures, and the UI's own icons. Creature models and item
// icons are converted on demand (see lazy.ts) unless `all` is set.
import type { GameData } from '@idle/sim';
import type { Client } from '../client.js';
import { convertCreature } from './creature.js';
import { convertIcons } from './icons.js';
import { convertUiAssets, UI_ICONS } from './ui-assets.js';
import { convertCharacters } from './characters.js';

export function convertArt(client: Client, data: GameData, cacheDir: string, log: (s: string) => void = console.log, all = false): void {
  const t0 = Date.now();
  const icons = convertIcons(client, all ? data : { ...data, items: {} }, cacheDir, UI_ICONS);
  log(`icons: ${icons.written} written${icons.missing.length ? `, missing: ${icons.missing.join(', ')}` : ''}${all ? '' : ' (item icons convert on demand)'}`);
  convertUiAssets(client, cacheDir, log);
  convertCharacters(client, cacheDir, [1, 2, 3, 4, 5, 6, 7, 8], log);
  if (all) {
    const displays = new Set<number>();
    for (const z of data.zones) for (const c of z.creatures) for (const d of data.creatures[c.id].displayIds) displays.add(d);
    let ok = 0; const skipped: string[] = [];
    for (const id of displays) {
      try { convertCreature(client, id, cacheDir); ok++; } catch (e) { skipped.push(`${id} (${(e as Error).message.split(':')[0]})`); }
    }
    log(`creature models: ${ok} converted, ${skipped.length} skipped`);
  } else {
    log('creature models: converted on demand while playing');
  }
  log(`art done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${cacheDir}`);
}
