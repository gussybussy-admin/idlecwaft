// Read access to the VMaNGOS world database, pinned to patch 1.12 (VMaNGOS patch index 10).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { LootEntry, LootTable } from '@idle/sim';

export const PATCH_1_12 = 10;

export type Row = Record<string, number | string | null>;

export class VMangos {
  readonly db: Database.Database;
  private lootCache = new Map<string, LootTable | null>();

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

  /**
   * Builds a loot table, resolving reference tables recursively. Quest-only drops (negative chance)
   * are skipped until quests exist. Every item id seen is added to `items`.
   */
  loot(table: string, entry: number, items: Set<number>, depth = 0): LootTable | null {
    const key = `${table}:${entry}`;
    if (this.lootCache.has(key)) {
      const t = this.lootCache.get(key)!;
      if (t) collectItems(t, items);
      return t;
    }
    if (!entry || depth > 6) return null;
    const rows = this.all(`SELECT * FROM ${table} WHERE entry=? AND patch_min<=? AND patch_max>=?`, entry, PATCH_1_12, PATCH_1_12);
    const out: LootTable = { entries: [], groups: [] };
    const groups = new Map<number, LootEntry[]>();
    for (const r of rows) {
      const chance = Number(r.ChanceOrQuestChance), group = Number(r.groupid);
      const minOrRef = Number(r.mincountOrRef), max = Number(r.maxcount);
      if (chance < 0) continue; // quest item
      let e: LootEntry;
      if (minOrRef < 0) {
        const ref = this.loot('reference_loot_template', -minOrRef, items, depth + 1);
        if (!ref) continue;
        e = { ref, chance, times: Math.max(1, max) };
      } else {
        if (!this.itemTemplate(Number(r.item))) continue;
        items.add(Number(r.item));
        e = { item: Number(r.item), chance, min: Math.max(1, minOrRef), max: Math.max(1, max, minOrRef) };
      }
      if (group) { if (!groups.has(group)) groups.set(group, []); groups.get(group)!.push(e); }
      else out.entries.push(e);
    }
    out.groups = [...groups.values()];
    const result = out.entries.length || out.groups.length ? out : null;
    this.lootCache.set(key, result);
    return result;
  }

  close(): void { this.db.close(); }
}

function collectItems(t: LootTable, items: Set<number>): void {
  for (const e of [...t.entries, ...t.groups.flat()]) {
    if ('item' in e) items.add(e.item); else collectItems(e.ref, items);
  }
}
