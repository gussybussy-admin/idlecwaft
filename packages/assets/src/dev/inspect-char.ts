// Dev helper: character model submeshes (geosets), texture slots and attachments.
import { loadConfig } from '../config.js';
import { Client } from '../client.js';
import { parseM2 } from '../m2/m2.js';

const client = new Client(loadConfig().clientPath);
const file = process.argv[2] ?? 'Character\\Human\\Male\\HumanMale.m2';
const m = parseM2(client.read(file));
const ids = m.skins[0].submeshes.map(s => s.id);
console.log(`${file}: ${m.vertices.length} verts, ${m.bones.length} bones, ${m.sequences.length} seqs`);
console.log('submesh ids:', [...new Set(ids)].sort((a, b) => a - b).join(' '));
console.log('textures:', m.textures.map((t, i) => `${i}:type${t.type}${t.filename ? '=' + t.filename : ''}`).join('  '));
console.log('batches:', m.skins[0].batches.map(b => `sm${m.skins[0].submeshes[b.submeshIndex].id}->tex${m.textureLookup[b.textureComboIndex]}`).join(' '));
const names = client.animationNames();
console.log('animations:', [...new Set(m.sequences.map(q => names.get(q.id) ?? q.id))].join(', '));
const bk = client.dbc('CreatureDisplayInfoExtra');
const r = bk.rows().find(r => bk.u32(r, 0) === 2236)!;
const bake = bk.str(r, 18);
console.log('bake', bake, 'exists:', client.archives.has(`Textures\\BakedNpcTextures\\${bake}`));
