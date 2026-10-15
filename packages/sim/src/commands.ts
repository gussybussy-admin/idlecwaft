// Every player action as data. The server validates and applies these; nothing else changes a
// character, so a command log plus the seeded RNG fully determines a character's history.
import type { GameData } from './data.js';
import type { Action, GameState, Profession, Slot } from './state.js';
import { PROFESSIONS, SLOTS } from './state.js';
import { learnTalent, resetTalents } from './talents.js';
import { abandonQuest, acceptQuest } from './quests.js';
import {
  buy, completeQuest, disenchant, equip, learnRecipe, unlearnProfession, sell, startAction, stopAction, train, trainRiding, trainSpells, unequip, type CommandResult,
} from './engine.js';

export type Command =
  | { name: 'start'; action: Action }
  | { name: 'stop' }
  | { name: 'train'; skill: Profession }
  | { name: 'learnRecipe'; recipe: number }
  | { name: 'buy'; item: number; count: number }
  | { name: 'sell'; item: number; count: number }
  | { name: 'sellJunk' }
  | { name: 'equip'; item: number }
  | { name: 'unequip'; slot: Slot }
  | { name: 'settings'; autoEat?: boolean; eatBelowPct?: number; restBelowPct?: number; autoSkin?: boolean; potionBelowPct?: number }
  | { name: 'trainRiding' }
  | { name: 'trainSpells' }
  | { name: 'learnTalent'; talent: number }
  | { name: 'resetTalents' }
  | { name: 'unlearn'; skill: Profession }
  | { name: 'disenchant'; item: number }
  | { name: 'acceptQuest'; quest: number }
  | { name: 'abandonQuest'; quest: number }
  | { name: 'turnInQuest'; quest: number; choice?: number };

const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Shape-checks untrusted input (from the network) into a Command, or returns null. */
export function parseCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  switch (c.name) {
    case 'start': {
      const a = c.action as Record<string, unknown> | undefined;
      if (!a) return null;
      if (a.kind === 'fight' && int(a.creature, 1, 1e7)) return { name: 'start', action: { kind: 'fight', creature: a.creature as number } };
      if (a.kind === 'gather' && int(a.node, 1, 1e7)) return { name: 'start', action: { kind: 'gather', node: a.node as number } };
      if (a.kind === 'fish') return { name: 'start', action: { kind: 'fish' } };
      if ((a.kind === 'craft' || a.kind === 'cook') && int(a.recipe, 1, 1e7)) {
        const action: Action = { kind: 'craft', recipe: a.recipe as number };
        if (int(a.count, 1, 10000)) action.count = a.count as number;
        if (SLOTS.includes(a.slot as Slot)) action.slot = a.slot as Slot;
        return { name: 'start', action };
      }
      if (a.kind === 'quest' && int(a.quest, 1, 1e7)) return { name: 'start', action: { kind: 'quest', quest: a.quest as number } };
      if (a.kind === 'travel' && int(a.to, 1, 1e7)) return { name: 'start', action: { kind: 'travel', to: a.to as number } };
      return null;
    }
    case 'stop': case 'sellJunk': case 'trainRiding': case 'trainSpells': case 'resetTalents': return { name: c.name };
    case 'learnTalent': return int(c.talent, 1, 1e7) ? { name: 'learnTalent', talent: c.talent as number } : null;
    case 'unlearn': return PROFESSIONS.includes(c.skill as Profession) ? { name: 'unlearn', skill: c.skill as Profession } : null;
    case 'disenchant': return int(c.item, 1, 1e7) ? { name: 'disenchant', item: c.item as number } : null;
    case 'acceptQuest': case 'abandonQuest': return int(c.quest, 1, 1e7) ? { name: c.name, quest: c.quest as number } : null;
    case 'turnInQuest': {
      if (!int(c.quest, 1, 1e7)) return null;
      return int(c.choice, 1, 1e7) ? { name: 'turnInQuest', quest: c.quest as number, choice: c.choice as number } : { name: 'turnInQuest', quest: c.quest as number };
    }
    case 'train': return PROFESSIONS.includes(c.skill as Profession) ? { name: 'train', skill: c.skill as Profession } : null;
    case 'learnRecipe': return int(c.recipe, 1, 1e7) ? { name: 'learnRecipe', recipe: c.recipe as number } : null;
    case 'buy': case 'sell':
      return int(c.item, 1, 1e7) && int(c.count, 1, 1000) ? { name: c.name, item: c.item as number, count: c.count as number } : null;
    case 'equip': return int(c.item, 1, 1e7) ? { name: 'equip', item: c.item as number } : null;
    case 'unequip': return SLOTS.includes(c.slot as Slot) ? { name: 'unequip', slot: c.slot as Slot } : null;
    case 'settings': {
      const out: Command = { name: 'settings' };
      if (typeof c.autoEat === 'boolean') out.autoEat = c.autoEat;
      if (int(c.eatBelowPct, 10, 99)) out.eatBelowPct = c.eatBelowPct as number;
      if (int(c.restBelowPct, 10, 99)) out.restBelowPct = c.restBelowPct as number;
      if (typeof c.autoSkin === 'boolean') out.autoSkin = c.autoSkin;
      if (int(c.potionBelowPct, 5, 90)) out.potionBelowPct = c.potionBelowPct as number;
      return out;
    }
    default: return null;
  }
}

export function applyCommand(s: GameState, data: GameData, c: Command): CommandResult {
  switch (c.name) {
    case 'start': return startAction(s, data, c.action);
    case 'stop': return stopAction(s);
    case 'train': return train(s, data, c.skill);
    case 'learnRecipe': return learnRecipe(s, data, c.recipe);
    case 'buy': return buy(s, data, c.item, c.count);
    case 'sell': return sell(s, data, c.item, c.count);
    case 'sellJunk': {
      for (const [id, n] of Object.entries(s.inventory)) if (data.items[+id]?.quality === 0 && data.items[+id].sellPrice) sell(s, data, +id, n);
      return { ok: true };
    }
    case 'equip': return equip(s, data, c.item);
    case 'unequip': return unequip(s, data, c.slot);
    case 'trainRiding': return trainRiding(s);
    case 'trainSpells': return trainSpells(s, data);
    case 'learnTalent': return learnTalent(s, data, c.talent);
    case 'resetTalents': return resetTalents(s);
    case 'unlearn': return unlearnProfession(s, data, c.skill);
    case 'disenchant': return disenchant(s, data, c.item);
    case 'acceptQuest': return acceptQuest(s, data, c.quest);
    case 'abandonQuest': return abandonQuest(s, data, c.quest);
    case 'turnInQuest': return completeQuest(s, data, c.quest, c.choice);
    case 'settings':
      if (c.autoEat !== undefined) s.settings.autoEat = c.autoEat;
      if (c.eatBelowPct !== undefined) s.settings.eatBelowPct = c.eatBelowPct;
      if (c.restBelowPct !== undefined) s.settings.restBelowPct = c.restBelowPct;
      if (c.autoSkin !== undefined) s.settings.autoSkin = c.autoSkin;
      if (c.potionBelowPct !== undefined) s.settings.potionBelowPct = c.potionBelowPct;
      return { ok: true };
  }
}
