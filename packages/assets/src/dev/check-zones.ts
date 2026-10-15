// Dev helper: sanity-check the ADT zone lookup on well-known coordinates.
import { loadConfig } from '../config.js';
import { Client } from '../client.js';
import { ZoneLookup } from '../import/zone-lookup.js';

const client = new Client(loadConfig().clientPath);
const zl = new ZoneLookup(client);
const at = client.dbc('AreaTable');
const names = new Map(at.rows().map(r => [at.u32(r, 0), at.str(r, 11)]));
const probes: [string, number, number, number][] = [
  ['Northshire Abbey', 0, -8913, -137],
  ['Goldshire', 0, -9464, 62],
  ['Westfall (Sentinel Hill)', 0, -10628, 1037],
  ['Ironforge gates', 0, -5039, -819],
  ['Orgrimmar gates', 1, 1630, -4373],
];
for (const [label, map, x, y] of probes) {
  const area = zl.areaAt(map, x, y), zone = zl.zoneOf(area);
  console.log(`${label.padEnd(26)} area=${area} (${names.get(area)}) zone=${zone} (${names.get(zone)})`);
}
console.log('AreaTable sample cols:', [0, 1, 2, 3, 4, 10, 11].map(f => `${f}=${at.str(0, f) || at.u32(0, f)}`).join(' '));
