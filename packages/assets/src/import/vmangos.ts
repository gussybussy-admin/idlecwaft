// Read access to the VMaNGOS world database, pinned to patch 1.12 (VMaNGOS patch index 10).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { LootEntry, LootRef, LootTable } from '@idle/sim';

export const PATCH_1_12 = 10;

export type Row = Record<string, number | string | null>;

export class VMangos {
  readonly db: Database.Database;
  private lootCache = new Map<LootRef, LootTable | null>();

  constructor(file: string) {
    if (!fs.existsSync(file)) throw new Error(`VMaNGOS world DB not found: ${file}`);
    this.db = new Database(file, { readonly: true, fileMustExist: true });
  }

  static open(repoRoot: string): VMangos {
    return new VMangos(path.join(repoRoot, 'data/vmangos/db/sqlite-dump/mangos.sqlite'));
  }

  all(sql: string, ...params: unknown[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  get(sql: string, ...params: unknown[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }

  /** Templates carry one row per patch; take the newest row at or before 1.12. */
  creatureTemplate(entry: number): Row | undefined {
    return this.get(`SELECT * FROM creature_template WHERE entry=? AND patch<=? ORDER BY patch DESC LIMIT 1`, entry, PATCH_1_12);
  }
  itemTemplate(entry: number): Row | undefined {
    return this.get(`SELECT * FROM item_template WHERE entry=? AND patch<=? ORDER BY patch DESC LIMIT 1`, entry, PATCH_1_12);
  }
  gameobjectTemplate(entry: number): Row | undefined {
    return this.get(`SELECT * FROM gameobject_template WHERE entry=? AND patch<=? ORDER BY patch DESC LIMIT 1`, entry, PATCH_1_12);
  }
  spell(entry: number): Row | undefined {
    return this.get(`SELECT * FROM spell_template WHERE entry=? AND build<=5875 ORDER BY build DESC LIMIT 1`, entry);
  }

  /**
   * Trainers and recipe items don't reference a recipe spell directly; they reference a "teach"
   * spell whose effect is LEARN_SPELL (36) pointing at it. Returns the spell plus all its teachers.
   */
  teachSpells(spell: number): number[] {
    const rows = this.all(`SELECT DISTINCT entry FROM spell_template WHERE build<=5875 AND
      ((effect1=36 AND effectTriggerSpell1=?) OR (effect2=36 AND effectTriggerSpell2=?) OR (effect3=36 AND effectTriggerSpell3=?))`, spell, spell, spell);
    return [spell, ...rows.map(r => Number(r.entry))];
  }

  /** Cheapest trainer offer for a spell (via any of its teach spells), if a trainer teaches it. */
  trainerOffer(spell: number): { cost: number; reqSkill: number; reqLevel: number } | null {
    let best: { cost: number; reqSkill: number; reqLevel: number } | null = null;
    for (const s of this.teachSpells(spell)) {
      for (const r of this.all(`SELECT spellcost, reqskillvalue, reqlevel FROM npc_trainer WHERE spell=? AND build_min<=5875 AND build_max>=5875
        UNION ALL SELECT spellcost, reqskillvalue, reqlevel FROM npc_trainer_template WHERE spell=? AND build_min<=5875 AND build_max>=5875`, s, s)) {
        const o = { cost: Number(r.spellcost), reqSkill: Number(r.reqskillvalue), reqLevel: Number(r.reqlevel) };
        if (!best || o.cost < best.cost) best = o;
      }
    }
    return best;
  }

  /** Recipe item (item class 9) that teaches a spell, if any. */
  recipeItem(spell: number): Row | undefined {
    for (const s of this.teachSpells(spell)) {
      const r = this.get(`SELECT entry, name, required_skill_rank FROM item_template WHERE class=9 AND patch<=?
        AND (spellid_1=? OR spellid_2=?) ORDER BY patch DESC LIMIT 1`, PATCH_1_12, s, s);
      if (r) return r;
    }
    return undefined;
  }

  /** Spawn guids that only appear during world events (Scourge Invasion, Children's Week, ...). */
  eventCreatureGuids(): Set<number> {
    return new Set(this.all(`SELECT guid FROM game_event_creature`).map(r => Number(r.guid)));
  }
  eventGameobjectGuids(): Set<number> {
    return new Set(this.all(`SELECT guid FROM game_event_gameobject`).map(r => Number(r.guid)));
  }

  /** Every loot table built so far, by key (`creature:12`, `ref:24001`, ...): becomes GameData.loot. */
  readonly tables: Record<LootRef, LootTable> = {};
  private itemCache = new Map<number, Row | undefined>();

  cachedItem(entry: number): Row | undefined {
    if (!this.itemCache.has(entry)) this.itemCache.set(entry, this.itemTemplate(entry));
    return this.itemCache.get(entry);
  }

  /**
   * Builds a loot table (and every reference table it uses) into `tables`, returning its key.
   * Quest-only drops (negative chance in MaNGOS) are kept with `quest: true`. Every item id seen is
   * added to `items`.
   */
  loot(table: string, entry: number, items: Set<number>, depth = 0): LootRef | null {
    const prefix = LOOT_PREFIX[table] ?? table;
    const key = `${prefix}:${entry}`;
    if (this.lootCache.has(key)) {
      const t = this.lootCache.get(key);
      if (t) collectItems(this.tables, key, items);
      return t ? key : null;
    }
    if (!entry || depth > 6) return null;
    this.lootCache.set(key, null); // guards against reference cycles while building
    const rows = this.all(`SELECT * FROM ${table} WHERE entry=? AND patch_min<=? AND patch_max>=?`, entry, PATCH_1_12, PATCH_1_12);
    const out: LootTable = { entries: [], groups: [] };
    const groups = new Map<number, LootEntry[]>();
    for (const r of rows) {
      const raw = Number(r.ChanceOrQuestChance), group = Number(r.groupid);
      const minOrRef = Number(r.mincountOrRef), max = Number(r.maxcount);
      let e: LootEntry;
      if (minOrRef < 0) {
        const ref = this.loot('reference_loot_template', -minOrRef, items, depth + 1);
        if (!ref) continue;
        e = { ref, chance: Math.abs(raw), times: Math.max(1, max) };
      } else {
        if (!this.cachedItem(Number(r.item))) continue;
        items.add(Number(r.item));
        e = { item: Number(r.item), chance: Math.abs(raw), min: Math.max(1, minOrRef), max: Math.max(1, max, minOrRef) };
        if (raw < 0) e.quest = true;
      }
      if (group) { if (!groups.has(group)) groups.set(group, []); groups.get(group)!.push(e); }
      else out.entries.push(e);
    }
    out.groups = [...groups.values()];
    const ok = out.entries.length > 0 || out.groups.length > 0;
    this.lootCache.set(key, ok ? out : null);
    if (ok) this.tables[key] = out;
    return ok ? key : null;
  }

  close(): void { this.db.close(); }
}

const LOOT_PREFIX: Record<string, string> = {
  creature_loot_template: 'creature', reference_loot_template: 'ref', gameobject_loot_template: 'go',
  fishing_loot_template: 'fish', skinning_loot_template: 'skin', pickpocketing_loot_template: 'pick',
  item_loot_template: 'item', disenchant_loot_template: 'de',
};

function collectItems(tables: Record<LootRef, LootTable>, key: LootRef, items: Set<number>, seen = new Set<string>()): void {
  const t = tables[key];
  if (!t || seen.has(key)) return;
  seen.add(key);
  for (const e of [...t.entries, ...t.groups.flat()]) {
    if ('item' in e) items.add(e.item); else collectItems(tables, e.ref, items, seen);
  }
}
