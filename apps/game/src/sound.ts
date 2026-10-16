// Sound: effects, voices, zone music and ambience from the player's own client (converted on first use,
// like the art: sounds/<SoundEntries id>.json lists the variations). Web Audio with one gain per channel;
// the browser only allows audio after a click, so everything stays silent until the first one.

export type Channel = 'effects' | 'voices' | 'music' | 'ambience';
export interface SoundSettings { master: number; effects: number; voices: number; music: number; ambience: number; muted: boolean }

const KEY = 'idlecwaft.sound';
const DEFAULTS: SoundSettings = { master: 0.8, effects: 0.8, voices: 0.7, music: 0.5, ambience: 0.5, muted: false };
const MAX_VOICES = 14;
/** Music plays a track, then a quiet stretch (ZoneMusic has 3-5 minutes; shorter suits short sessions). */
const MUSIC_GAP_MS: [number, number] = [45_000, 120_000];

interface Index { files: string[]; volume: number }

class SoundSystem {
  settings: SoundSettings = load();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<Channel, GainNode>();
  private indexes = new Map<number, Promise<Index | null>>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private lastPlayed = new Map<number, number>();
  private playing = 0;
  private listeners = new Set<() => void>();
  // music + ambience
  private zoneLoop: { key: string; music: number; ambience: number; timer: number; src: AudioBufferSourceNode | null; amb: AudioBufferSourceNode | null } | null = null;

  constructor() {
    const unlock = () => { this.ensure(); this.ctx?.resume().catch(() => {}); };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    for (const ch of ['effects', 'voices', 'music', 'ambience'] as Channel[]) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.buses.set(ch, g);
    }
    this.apply();
    // A zone was set before audio was allowed: start it now.
    if (this.zoneLoop) { const z = this.zoneLoop; this.zoneLoop = null; this.zone(z.music, z.ambience); }
    return this.ctx;
  }

  private apply() {
    if (!this.master) return;
    this.master.gain.value = this.settings.muted ? 0 : this.settings.master;
    for (const [ch, g] of this.buses) g.gain.value = this.settings[ch];
  }

  set(patch: Partial<SoundSettings>) {
    this.settings = { ...this.settings, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    this.apply();
    this.listeners.forEach(l => l());
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSettings = () => this.settings;

  private index(id: number): Promise<Index | null> {
    let p = this.indexes.get(id);
    if (!p) this.indexes.set(id, p = fetch(`sounds/${id}.json`).then(r => (r.ok ? r.json() as Promise<Index> : null)).catch(() => null));
    return p;
  }
  private buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url);
    if (!p) {
      const ctx = this.ctx!;
      p = fetch(url).then(r => (r.ok ? r.arrayBuffer() : null)).then(b => (b ? ctx.decodeAudioData(b) : null)).catch(() => null);
      this.buffers.set(url, p);
      if (this.buffers.size > 400) this.buffers.delete(this.buffers.keys().next().value!); // keep memory bounded
    }
    return p;
  }

  /** Play a SoundEntries sound once (a random variation). Quietly does nothing without audio or data. */
  async play(id: number | undefined, channel: Channel = 'effects', volume = 1): Promise<void> {
    if (!id || this.settings.muted || document.hidden) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(id) ?? 0) < 90 || this.playing >= MAX_VOICES) return; // no machine-gun stacking
    this.lastPlayed.set(id, now);
    const idx = await this.index(id);
    if (!idx?.files.length) return;
    const buf = await this.buffer(idx.files[Math.floor(Math.random() * idx.files.length)]);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, idx.volume * volume);
    src.connect(g).connect(this.buses.get(channel)!);
    this.playing++;
    src.onended = () => { this.playing--; g.disconnect(); };
    src.start();
  }

  /** The zone's music and ambience (SoundEntries ids; 0 for none). Changing zones crossfades. */
  zone(music: number, ambience: number) {
    const key = `${music}:${ambience}`;
    if (this.zoneLoop?.key === key) return;
    this.stopZone();
    this.zoneLoop = { key, music, ambience, timer: 0, src: null, amb: null };
    const ctx = this.ctx;
    if (!ctx) return; // starts on the first click (ensure)
    const z = this.zoneLoop;
    const loop = async (channel: 'music' | 'ambience', id: number, repeat: boolean) => {
      if (!id || this.zoneLoop !== z) return;
      const idx = await this.index(id);
      const buf = idx?.files.length ? await this.buffer(idx.files[Math.floor(Math.random() * idx.files.length)]) : null;
      if (!buf || this.zoneLoop !== z) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !repeat; // ambience loops seamlessly; music plays, pauses, plays again
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(Math.min(1, idx!.volume), ctx.currentTime + 3);
      src.connect(g).connect(this.buses.get(channel)!);
      src.start();
      if (channel === 'music') z.src = src; else z.amb = src;
      if (repeat) src.onended = () => {
        if (this.zoneLoop !== z) return;
        const gap = MUSIC_GAP_MS[0] + Math.random() * (MUSIC_GAP_MS[1] - MUSIC_GAP_MS[0]);
        z.timer = window.setTimeout(() => loop('music', z.music, true), gap);
      };
    };
    loop('music', music, true);
    loop('ambience', ambience, false);
  }

  private stopZone() {
    const z = this.zoneLoop;
    if (!z) return;
    clearTimeout(z.timer);
    for (const src of [z.src, z.amb]) {
      if (!src || !this.ctx) continue;
      try { src.onended = null; src.stop(this.ctx.currentTime + 1.5); } catch { /* already stopped */ }
    }
    this.zoneLoop = null;
  }
}

function load(): SoundSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

export const sound = new SoundSystem();

/** Day or night music: 6:00 to 20:00 local time is day. */
export const isDay = () => { const h = new Date().getHours(); return h >= 6 && h < 20; };
