// Raid boss mechanics. Raid bosses run on C++ encounter scripts in VMaNGOS, so unlike dungeon creatures
// they have no spell lists to read. This table names each boss's signature abilities (by spell name),
// who they hit and how often; the spell's damage, school and effect come from the spell table itself.
// These are the mechanics the group simulation turns into fire/frost/nature/shadow pressure, fears,
// knockbacks and adds, which resistance gear and protection potions counter.
import type { AbilityEffect, CreatureAbility } from '@idle/sim';
import type { Row, VMangos } from './vmangos.js';

type Target = CreatureAbility['target'] | 'all' | 'melee';
/**
 * [spell name, target, every (seconds, min-max), first cast (seconds, min-max), fallback effects]. The
 * fallback is used only when the spell itself has no usable effect (a script trigger, like Deep Breath).
 */
type Mech = [string, Target, [number, number], [number, number]?, AbilityEffect[]?];

export const RAID_MECHANICS: Record<string, Mech[]> = {
  // ---- Molten Core (fire)
  'Lucifron': [['Impending Doom', 'all', [20, 20], [10, 10]], ["Lucifron's Curse", 'all', [20, 20], [20, 20]], ['Shadow Shock', 'tank', [6, 6]]],
  'Gehennas': [['Rain of Fire', 'all', [6, 12]], ["Gehennas' Curse", 'all', [30, 30]], ['Shadow Bolt', 'random', [3, 3]]],
  'Garr': [['Antimagic Pulse', 'all', [15, 15]], ['Magma Shackles', 'all', [15, 15]]],
  'Shazzrah': [['Arcane Explosion', 'melee', [5, 9]], ["Shazzrah's Curse", 'all', [20, 25]], ['Counterspell', 'all', [15, 18]]],
  'Baron Geddon': [['Inferno', 'all', [45, 45]], ['Living Bomb', 'random', [20, 20]], ['Ignite Mana', 'all', [30, 30]]],
  'Golemagg the Incinerator': [['Pyroblast', 'random', [7, 7]], ['Earthquake', 'melee', [5, 5], [60, 60]]],
  'Sulfuron Harbinger': [['Hand of Ragnaros', 'melee', [12, 15]], ['Flame Spear', 'random', [12, 16]], ['Inspire', 'self', [13, 13]]],
  'Majordomo Executus': [['Magic Reflection', 'self', [30, 30]], ['Teleport', 'tank', [20, 20]]],
  'Ragnaros': [['Wrath of Ragnaros', 'melee', [25, 25], [30, 30]], ['Lava Burst', 'random', [10, 10]], ['Magma Blast', 'random', [5, 5], [60, 60]], ['Elemental Fire', 'tank', [10, 10]]],
  // ---- Onyxia's Lair (fire)
  'Onyxia': [['Flame Breath', 'tank', [10, 20]], ['Wing Buffet', 'tank', [15, 20]], ['Deep Breath', 'all', [30, 40], [60, 60], [{ k: 'damage', school: 2, min: 3000, max: 4500 }]], ['Fireball', 'random', [3, 5], [40, 40]], ['Bellowing Roar', 'all', [20, 30], [120, 120]]],
  // ---- Blackwing Lair (fire, shadow)
  'Razorgore the Untamed': [['Fireball Volley', 'all', [12, 15]], ['Conflagration', 'tank', [12, 12]], ['War Stomp', 'melee', [30, 30]]],
  'Vaelastrasz the Corrupt': [['Fire Nova', 'all', [3, 5]], ['Flame Breath', 'tank', [10, 15]], ['Burning Adrenaline', 'random', [15, 15]]],
  'Broodlord Lashlayer': [['Blast Wave', 'all', [8, 16]], ['Mortal Strike', 'tank', [20, 30]], ['Knock Away', 'tank', [12, 16]]],
  'Firemaw': [['Shadow Flame', 'melee', [15, 18]], ['Wing Buffet', 'tank', [30, 30]], ['Flame Buffet', 'all', [5, 5]]],
  'Ebonroc': [['Shadow Flame', 'melee', [15, 18]], ['Wing Buffet', 'tank', [30, 30]], ['Shadow of Ebonroc', 'tank', [8, 10]]],
  'Flamegor': [['Shadow Flame', 'melee', [15, 18]], ['Wing Buffet', 'tank', [30, 30]], ['Frenzy', 'self', [10, 15]]],
  'Chromaggus': [['Incinerate', 'all', [30, 30]], ['Corrosive Acid', 'all', [30, 30], [45, 45]], ['Frost Burn', 'all', [30, 30], [60, 60]], ['Ignite Flesh', 'all', [30, 30], [75, 75]], ['Time Lapse', 'all', [30, 30], [90, 90]]],
  'Nefarian': [['Shadow Flame', 'all', [12, 18]], ['Bellowing Roar', 'all', [25, 30]], ['Veil of Shadow', 'tank', [15, 20]], ['Shadow Bolt Volley', 'all', [10, 15]]],
  // ---- Zul'Gurub (nature, shadow)
  'High Priest Venoxis': [['Poison Cloud', 'all', [15, 20]], ['Holy Nova', 'all', [10, 15]], ['Holy Fire', 'random', [8, 12]]],
  "High Priestess Jeklik": [['Shadow Word: Pain', 'random', [10, 12]], ['Mind Flay', 'random', [12, 16]], ['Great Heal', 'self', [25, 30]]],
  "High Priestess Mar'li": [['Poison Volley', 'all', [10, 15]], ['Drain Life', 'random', [15, 20]]],
  'Bloodlord Mandokir': [['Whirlwind', 'melee', [20, 25]], ['Charge', 'random', [15, 20]], ['Fear', 'all', [30, 30]]],
  "Jin'do the Hexxer": [['Shadow Shock', 'random', [8, 10]], ['Hex', 'random', [15, 20]], ['Brain Wash Totem', 'random', [20, 25]]],
  'Hakkar': [['Corrupted Blood', 'all', [30, 45]], ['Cause Insanity', 'random', [25, 30]], ['Blood Siphon', 'self', [90, 90]]],
  "Gahz'ranka": [['Frost Breath', 'all', [10, 15]], ['Massive Geyser', 'all', [20, 25]]],
  // ---- Ruins of Ahn'Qiraj (nature, arcane)
  'Kurinnaxx': [['Mortal Wound', 'tank', [8, 10]], ['Sand Trap', 'random', [15, 20]]],
  'Moam': [['Arcane Eruption', 'all', [90, 90]], ['Trample', 'melee', [15, 20]]],
  'Buru the Gorger': [['Dismember', 'random', [8, 12]], ['Creeping Plague', 'all', [10, 10], [120, 120]]],
  'Ayamiss the Hunter': [['Stinger Spray', 'all', [10, 15]], ['Poison Stinger', 'random', [5, 8]]],
  'Ossirian the Unscarred': [['War Stomp', 'melee', [30, 30]], ['Cyclone', 'tank', [20, 20]], ['Curse of Tongues', 'all', [20, 20]]],
  // ---- Temple of Ahn'Qiraj (nature, arcane)
  'The Prophet Skeram': [['Arcane Explosion', 'melee', [8, 18]], ['Earth Shock', 'tank', [3, 5]], ['True Fulfillment', 'random', [20, 30]]],
  'Battleguard Sartura': [['Whirlwind', 'melee', [20, 25]], ['Enrage', 'self', [60, 60], [300, 300]]],
  'Fankriss the Unyielding': [['Mortal Wound', 'tank', [7, 10]], ['Entangle', 'random', [25, 25]]],
  'Viscidus': [['Poison Bolt Volley', 'all', [10, 15]], ['Toxin', 'all', [10, 10]]],
  'Princess Huhuran': [['Acid Spit', 'all', [10, 15]], ['Noxious Poison', 'random', [10, 20]], ['Wyvern Sting', 'all', [25, 40]], ['Frenzy', 'self', [25, 35]]],
  "Emperor Vek'lor": [['Arcane Burst', 'all', [15, 15]], ['Blizzard', 'all', [15, 20]], ['Shadow Bolt', 'random', [3, 3]]],
  "Emperor Vek'nilash": [['Uppercut', 'tank', [10, 15]], ['Unbalancing Strike', 'tank', [8, 10]]],
  'Ouro': [['Sweep', 'melee', [20, 20]], ['Sand Blast', 'tank', [20, 25]]],
  "C'Thun": [['Eye Beam', 'random', [3, 3]], ['Dark Glare', 'all', [45, 45], [45, 45]]],
  // ---- Naxxramas (nature, shadow, frost)
  "Anub'Rekhan": [['Impale', 'all', [15, 15]], ['Locust Swarm', 'all', [90, 90], [90, 90]]],
  'Grand Widow Faerlina': [['Poison Bolt Volley', 'all', [11, 11]], ['Rain of Fire', 'all', [16, 16]]],
  'Maexxna': [['Web Wrap', 'random', [40, 40]], ['Poison Shock', 'all', [10, 10]], ['Necrotic Poison', 'tank', [30, 30]], ['Web Spray', 'all', [40, 40]]],
  'Noth the Plaguebringer': [['Curse of the Plaguebringer', 'all', [50, 60]], ['Blink', 'tank', [25, 30]]],
  'Heigan the Unclean': [['Eruption', 'all', [10, 15]], ['Plague Cloud', 'all', [45, 45]]],
  'Loatheb': [['Inevitable Doom', 'all', [30, 30], [120, 120]], ['Corrupted Mind', 'all', [60, 60]]],
  'Instructor Razuvious': [['Disrupting Shout', 'melee', [25, 25]], ['Unbalancing Strike', 'tank', [30, 30]]],
  'Gothik the Harvester': [['Shadow Bolt', 'random', [2, 3]], ['Harvest Soul', 'all', [15, 15]]],
  'Highlord Mograine': [['Mark of Mograine', 'all', [12, 15]], ['Righteous Fire', 'tank', [10, 15]]],
  'Thane Korth\'azz': [['Mark of Korth\'azz', 'all', [12, 15]], ['Meteor', 'tank', [20, 20]]],
  'Lady Blaumeux': [['Mark of Blaumeux', 'all', [12, 15]], ['Void Zone', 'random', [12, 15]]],
  'Sir Zeliek': [['Mark of Zeliek', 'all', [12, 15]], ['Holy Wrath', 'all', [12, 15]]],
  'Patchwerk': [['Hateful Strike', 'tank', [1, 1]], ['Frenzy', 'self', [60, 60], [300, 300]]],
  'Grobbulus': [['Mutating Injection', 'random', [20, 20]], ['Slime Spray', 'all', [20, 30]]],
  'Gluth': [['Mortal Wound', 'tank', [10, 10]], ['Decimate', 'all', [105, 105], [105, 105]], ['Frenzy', 'self', [15, 15]]],
  'Sapphiron': [['Frost Aura', 'all', [3, 3]], ['Life Drain', 'all', [24, 24]], ['Blizzard', 'all', [10, 15]], ['Frost Breath', 'all', [60, 60], [90, 90]]],
  "Kel'Thuzad": [['Frostbolt', 'tank', [3, 5]], ['Frost Blast', 'random', [30, 40]], ['Shadow Fissure', 'random', [15, 20]], ['Detonate Mana', 'random', [20, 30]]],
};

/** Event NPCs that are placed as world bosses but aren't fights of their own. */
export const NOT_BOSSES = new Set(['Lord Victor Nefarius']);

/** Raids: their final placed boss (for ordering) and bosses that only appear through events (appended last). */
/** Boss phases (adds by creature name; see BossPhase). */
export const PHASES: Record<string, { name: string; hpPct?: number; atMs?: number; everyMs?: number; adds?: [string, number][];
  untargetable?: number | 'adds'; damageTaken?: number; untilHpPct?: number }[]> = {
  'Onyxia': [
    { name: 'Onyxia takes to the air; whelps pour out', hpPct: 65, adds: [['Onyxian Whelp', 6]], damageTaken: 0.5, untilHpPct: 40 },
    { name: 'Onyxia lands, enraged', hpPct: 40, adds: [['Onyxian Lair Guard', 2]] },
  ],
  'Ragnaros': [{ name: 'Ragnaros submerges: the Sons of Flame rise', atMs: 180_000, everyMs: 270_000, adds: [['Son of Flame', 8]], untargetable: 90_000 }],
  'Nefarian': [
    { name: 'Lord Victor Nefarius sends his drakonids', atMs: 0, adds: [['Black Drakonid', 3], ['Red Drakonid', 3], ['Bronze Drakonid', 2]], untargetable: 'adds' },
    { name: 'The fallen drakonids rise again', hpPct: 20, adds: [['Bone Construct', 6]] },
  ],
  "C'Thun": [
    { name: 'Claw Tentacle', atMs: 8000, everyMs: 30_000, adds: [['Claw Tentacle', 1]] },
    { name: 'Eye Tentacles burst from the ground', atMs: 45_000, everyMs: 45_000, adds: [['Eye Tentacle', 8]] },
  ],
  "Kel'Thuzad": [
    { name: 'The Scourge of the Necropolis', atMs: 0, adds: [['Soldier of the Frozen Wastes', 8], ['Unstoppable Abomination', 2], ['Soul Weaver', 2]], untargetable: 'adds' },
    { name: 'Guardians of Icecrown', hpPct: 40, adds: [['Guardian of Icecrown', 2]] },
  ],
  'Hakkar': [{ name: 'Sons of Hakkar', atMs: 20_000, everyMs: 60_000, adds: [['Son of Hakkar', 2]] }],
  'Majordomo Executus': [{ name: 'Flamewaker guards', atMs: 0, adds: [['Flamewaker Healer', 4], ['Flamewaker Elite', 4]] }],
  'Ossirian the Unscarred': [{ name: 'Sand vortices', atMs: 30_000, everyMs: 60_000, adds: [['Sand Vortex', 2]] }],
};

/** Raid attunements: clear a dungeon once (or complete its quest), or reach a reputation. */
export const ATTUNE: Record<number, { dungeon?: string; quest?: number; rep?: [number, number]; text: string }> = {
  409: { dungeon: 'Blackrock Depths', quest: 7848, text: 'Attunement to the Core: clear Blackrock Depths once' },
  249: { dungeon: 'Upper Blackrock Spire', text: 'The Drakefire Amulet: clear Upper Blackrock Spire once' },
  469: { dungeon: 'Lower Blackrock Spire', text: "Blackhand's Command: clear Lower Blackrock Spire once" },
  533: { quest: 9123, rep: [529, 5], text: 'The Dread Citadel: Honored with the Argent Dawn' },
};

export const RAIDS: { map: number; size: number; tier: number; anchor: string; extra?: string[]; beforeFinal?: string[]; order?: string[] }[] = [
  { map: 409, size: 40, tier: 1, anchor: 'Golemagg the Incinerator', extra: ['Majordomo Executus', 'Ragnaros'],
    order: ['Lucifron', 'Magmadar', 'Gehennas', 'Garr', 'Baron Geddon', 'Shazzrah', 'Sulfuron Harbinger', 'Golemagg the Incinerator'] },
  { map: 249, size: 40, tier: 1, anchor: 'Onyxia' },
  { map: 309, size: 20, tier: 1, anchor: 'Hakkar',
    order: ['High Priest Venoxis', 'High Priestess Jeklik', "High Priestess Mar'li", 'Bloodlord Mandokir', "Gahz'ranka", 'High Priest Thekal', "Jin'do the Hexxer", 'Hakkar'] },
  { map: 469, size: 40, tier: 2, anchor: 'Chromaggus', extra: ['Nefarian'],
    order: ['Razorgore the Untamed', 'Vaelastrasz the Corrupt', 'Broodlord Lashlayer', 'Firemaw', 'Ebonroc', 'Flamegor', 'Chromaggus'] },
  { map: 509, size: 20, tier: 1, anchor: 'Ossirian the Unscarred',
    order: ['Kurinnaxx', 'Captain Qeez', 'Captain Tuubid', 'Captain Drenn', 'Captain Xurrem', 'Major Yeggeth', 'Major Pakkon', 'Colonel Zerran', 'General Rajaxx', 'Moam', 'Buru the Gorger', 'Ayamiss the Hunter', 'Ossirian the Unscarred'] },
  { map: 531, size: 40, tier: 3, anchor: "C'Thun", beforeFinal: ['Ouro'],
    order: ['The Prophet Skeram', 'Vem', 'Lord Kri', 'Princess Yauj', 'Battleguard Sartura', 'Fankriss the Unyielding', 'Viscidus', 'Princess Huhuran', "Emperor Vek'lor", "Emperor Vek'nilash", "C'Thun"] },
  { map: 533, size: 40, tier: 4, anchor: "Kel'Thuzad", beforeFinal: ['Sapphiron'],
    order: ["Anub'Rekhan", 'Grand Widow Faerlina', 'Maexxna', 'Noth the Plaguebringer', 'Heigan the Unclean', 'Loatheb', 'Instructor Razuvious',
      'Gothik the Harvester', 'Highlord Mograine', "Thane Korth'azz", 'Lady Blaumeux', 'Sir Zeliek', 'Patchwerk', 'Grobbulus', 'Gluth', 'Thaddius', "Kel'Thuzad"] },
];

const DAMAGE_CAP = 6000; // per hit, so a shared spell name can't pick some far bigger scripted version

/** The abilities of a raid boss from the table: each spell found by name, its effects from the spell data. */
export function raidAbilities(vm: VMangos, boss: string, spellEffects: (s: Row) => AbilityEffect[]): CreatureAbility[] | undefined {
  const mechs = RAID_MECHANICS[boss];
  if (!mechs) return undefined;
  const out: CreatureAbility[] = [];
  for (const [name, target, every, first, fallback] of mechs) {
    // Creature versions only (no player-class spell family), and the median of them: names like
    // "Arcane Explosion" or "Fireball" exist in many sizes, from player ranks to scripted extremes.
    const versions = vm.all(`SELECT * FROM spell_template s WHERE name = ? AND spellFamilyName = 0 AND build = (SELECT MAX(build) FROM spell_template WHERE entry = s.entry AND build <= 5875)`, name);
    const candidates: { row: Row; effects: AbilityEffect[]; size: number }[] = [];
    for (const row of versions) {
      const effects = spellEffects(row);
      if (!effects.length) continue;
      const size = effects.reduce((a, e) => a + (e.k === 'damage' ? (e.min + e.max) / 2 : e.k === 'dot' ? e.perTick * e.ticks : 1), 0);
      const maxHit = Math.max(0, ...effects.map(e => (e.k === 'damage' ? e.max : e.k === 'dot' ? e.perTick : 0)));
      if (maxHit > DAMAGE_CAP) continue;
      candidates.push({ row, effects, size });
    }
    candidates.sort((a, b) => a.size - b.size);
    let best: { row: Row; effects: AbilityEffect[]; size: number } | null = candidates[Math.floor(candidates.length / 2)] ?? null;
    if (!best && fallback) best = { row: versions[0] ?? { entry: 0 }, effects: fallback, size: 0 };
    if (!best) continue;
    out.push({
      spell: Number(best.row.entry), name, aoe: target === 'all' || target === 'melee', ...(target === 'melee' ? { melee: true } : {}),
      target: target === 'all' || target === 'melee' ? 'tank' : target,
      firstMs: [(first ?? every)[0] * 1000, (first ?? every)[1] * 1000],
      repeatMs: [every[0] * 1000, every[1] * 1000], chance: 100, effects: best.effects,
    });
  }
  return out.length ? out : undefined;
}
