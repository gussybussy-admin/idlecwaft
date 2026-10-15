// Converts everything the game client renders for a world, from the player's own client:
// icons, UI art, fonts, scenery, character models + appearance textures, creature models.
import type { GameData } from '@idle/sim';
import type { Client } from '../client.js';
import { convertCreature } from './creature.js';
import { convertIcons } from './icons.js';
import { convertUiAssets, UI_ICONS } from './ui-assets.js';
import { convertCharacters } from './characters.js';

export function convertArt(client: Client, data: GameData, cacheDir: string, log: (s: string) => void = console.log): void {
  const t0 = Date.now();
  const icons = convertIcons(client, data, cacheDir, UI_ICONS);
  log(`icons: ${icons.written} written${icons.missing.length ? `, missing: ${icons.missing.join(', ')}` : ''}`);
  convertUiAssets(client, cacheDir, log);
  convertCharacters(client, cacheDir, [1, 2, 3, 4, 5, 6, 7, 8], log);
  const displays = new Set<number>();
  for (const z of data.zones) for (const c of z.creatures) for (const d of data.creatures[c.id].displayIds) displays.add(d);
  let ok = 0; const skipped: string[] = [];
  for (const id of displays) {
    try { convertCreature(client, id, cacheDir); ok++; } catch (e) { skipped.push(`${id} (${(e as Error).message.split(':')[0]})`); }
  }
  log(`creature models: ${ok} converted, ${skipped.length} skipped`);
  if (skipped.length) log(`  skipped: ${skipped.slice(0, 12).join('; ')}${skipped.length > 12 ? ' …' : ''}`);
  log(`art done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${cacheDir}`);
}
