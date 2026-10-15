// High-level access to a local 1.12 client: archives plus the DBC lookups the pipeline needs.
import path from 'node:path';
import { ClientArchives } from './mpq/mpq.js';
import { parseDBC, type DBC } from './dbc/dbc.js';

export interface CreatureDisplay {
  id: number; modelId: number; extraId: number; scale: number; opacity: number;
  skins: [string, string, string];
  modelPath: string; // as an .m2 path inside the archives
}

export class Client {
  readonly archives: ClientArchives;
  private dbcs = new Map<string, DBC>();
  private displays?: Map<number, CreatureDisplay>;

  constructor(clientPath: string) {
    this.archives = new ClientArchives(path.join(clientPath, 'Data'));
  }

  dbc(name: string): DBC {
    let d = this.dbcs.get(name);
    if (!d) {
      const buf = this.archives.read(`DBFilesClient\\${name}.dbc`);
      if (!buf) throw new Error(`DBC not found: ${name}`);
      this.dbcs.set(name, d = parseDBC(buf));
    }
    return d;
  }

  /** AnimationData.dbc: 0 id, 1 name */
  animationNames(): Map<number, string> {
    const d = this.dbc('AnimationData');
    return new Map(d.rows().map(r => [d.u32(r, 0), d.str(r, 1)]));
  }

  /**
   * CreatureDisplayInfo.dbc: 0 id, 1 modelId, 3 extraDisplayInfoId, 4 scale, 5 opacity, 6-8 skin textures.
   * CreatureModelData.dbc:   0 id, 2 model path (stored as .mdx, shipped as .m2).
   */
  creatureDisplays(): Map<number, CreatureDisplay> {
    if (!this.displays) {
      const md = this.dbc('CreatureModelData');
      const models = new Map(md.rows().map(r => [md.u32(r, 0), md.str(r, 2).replace(/\.mdx$/i, '.m2')]));
      const cd = this.dbc('CreatureDisplayInfo');
      this.displays = new Map(cd.rows().map(r => [cd.u32(r, 0), {
        id: cd.u32(r, 0), modelId: cd.u32(r, 1), extraId: cd.u32(r, 3),
        scale: cd.f32(r, 4), opacity: cd.u32(r, 5),
        skins: [cd.str(r, 6), cd.str(r, 7), cd.str(r, 8)] as [string, string, string],
        modelPath: models.get(cd.u32(r, 1)) ?? '',
      }]));
    }
    return this.displays;
  }

  read(file: string): Buffer {
    const b = this.archives.read(file);
    if (!b) throw new Error(`file not found in client: ${file}`);
    return b;
  }

  close(): void { this.archives.close(); }
}
