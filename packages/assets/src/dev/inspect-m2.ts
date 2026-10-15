// Dev helper: print a summary of an M2 from the client, e.g. `tsx inspect-m2.ts creature\murloc\murloc.m2`
import path from 'node:path';
import { loadConfig } from '../config.js';
import { ClientArchives } from '../mpq/mpq.js';
import { parseM2 } from '../m2/m2.js';
import { blpInfo } from '../blp/blp.js';

const cfg = loadConfig();
const client = new ClientArchives(path.join(cfg.clientPath, 'Data'));
const query = (process.argv[2] ?? 'murloc').toLowerCase();
const matches = client.list(n => n.endsWith('.m2') && n.includes(query));
console.log(`matches (${matches.length}):`, matches.slice(0, 15).join(', '));
const file = matches.find(n => n === query) ?? matches[0];
const m = parseM2(client.read(file)!);
console.log(`\n${file}: v${m.version} name=${m.name} verts=${m.vertices.length} bones=${m.bones.length} seqs=${m.sequences.length} skins=${m.skins.length} radius=${m.boundingRadius.toFixed(2)}`);
console.log('textures:', m.textures.map(t => `${t.type}:${t.filename || '-'}(f${t.flags})`).join(' '));
console.log('materials:', m.materials.map(x => `${x.flags}/${x.blendMode}`).join(' '));
const s = m.skins[0];
console.log(`skin0: verts=${s.vertices.length} tris=${s.indices.length / 3} submeshes=${s.submeshes.length} batches=${s.batches.length}`);
console.log('submeshes:', s.submeshes.map(x => `${x.id}[v${x.vertexStart}+${x.vertexCount} i${x.indexStart}+${x.indexCount}]`).join(' '));
console.log('batches:', s.batches.map(b => `sm${b.submeshIndex} mat${b.materialIndex} tex${m.textureLookup[b.textureComboIndex]}`).join(' '));
console.log('sequences:', m.sequences.map(q => `${q.id}.${q.variation}(${q.end - q.start}ms f${q.flags.toString(16)})`).join(' '));
const rot = m.bones.flatMap(b => b.rotation.values.slice(0, 2));
console.log('sample quats (should be ~unit):', rot.slice(0, 4).map(q => `${q.map(v => v.toFixed(3)).join(',')}|n=${Math.hypot(...q).toFixed(3)}`).join('  '));
console.log('bone0 rot ranges', m.bones[0].rotation.ranges.length, 'ts', m.bones[0].rotation.timestamps.length, 'interp', m.bones[0].rotation.interpolation);
const dir = path.dirname(file);
const blps = client.list(n => n.startsWith(dir + '\\') && n.endsWith('.blp'));
console.log('\ntextures in folder:', blps.map(b => { const i = blpInfo(client.read(b)!); return `${path.basename(b)} ${i.width}x${i.height} c${i.compression} a${i.alphaDepth}/${i.alphaType}`; }).join('\n  '));
