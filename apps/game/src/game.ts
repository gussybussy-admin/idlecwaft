// Client-side game controller for the single-player phase: owns the state, drives the sim clock,
// saves to localStorage and runs offline catch-up on load. Phase 3 moves the authority (and the
// clock) to the server; this file then becomes a thin sync layer over the same @idle/sim calls.
import {
  advance, catchUp, newGame, type Appearance, type CommandResult, type GameData, type GameState, type SimEvent, type Summary,
} from '@idle/sim';

const SAVE_KEY = 'idlecwaft.save.v1';
const TICK_MS = 200;
const AUTOSAVE_MS = 10_000;
/** Absences shorter than this don't get a "while you were away" report. */
const REPORT_MIN_MS = 60_000;

type Listener = () => void;
type EventListener = (e: SimEvent) => void;

export class Game {
  data!: GameData;
  state: GameState | null = null;
  away: Summary | null = null;
  toast: string | null = null;
  private version = 0;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();
  private timer: number | undefined;
  private lastSave = 0;

  async load(): Promise<void> {
    const res = await fetch('data/game.json');
    if (!res.ok) throw new Error('No game data in the cache. Run: npm run assets -- import');
    this.data = await res.json();
    const saved = readSave();
    if (saved) {
      this.state = saved;
      const sum = catchUp(this.state, this.data, Date.now());
      if (sum.ms >= REPORT_MIN_MS) this.away = sum;
      this.save();
    }
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.save(); else this.tick(); });
    addEventListener('pagehide', () => this.save());
    this.bump();
  }

  create(name: string, race: number, cls: number, look?: Appearance): void {
    this.state = newGame(this.data, { name, race, cls, look, seed: (Math.random() * 2 ** 32) >>> 0, now: Date.now() });
    this.save();
    this.bump();
  }

  /** Advance the sim to wall time and forward every event to the diorama and UI. */
  tick(): void {
    if (!this.state) return;
    const now = Date.now();
    if (now - this.state.now > 5 * 60_000) {
      // The tab was suspended for a while: treat it like an offline absence.
      const sum = catchUp(this.state, this.data, now);
      if (sum.ms >= REPORT_MIN_MS) this.away = sum;
    } else {
      advance(this.state, this.data, now, e => { for (const l of this.eventListeners) l(e); });
    }
    if (now - this.lastSave > AUTOSAVE_MS) this.save();
    this.bump();
  }

  /** Run a sim command at the current wall time. */
  command(fn: (s: GameState, d: GameData) => CommandResult): boolean {
    if (!this.state) return false;
    advance(this.state, this.data, Date.now(), e => { for (const l of this.eventListeners) l(e); });
    const r = fn(this.state, this.data);
    if (!r.ok) this.showToast(r.error);
    this.save();
    this.bump();
    return r.ok;
  }

  showToast(text: string): void {
    this.toast = text;
    this.bump();
    window.setTimeout(() => { if (this.toast === text) { this.toast = null; this.bump(); } }, 3000);
  }

  dismissAway(): void { this.away = null; this.bump(); }

  save(): void {
    if (!this.state) return;
    this.lastSave = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); } catch { /* storage unavailable: keep playing */ }
  }

  resetSave(): void {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    this.state = null;
    this.bump();
  }

  exportSave(): string { return btoa(unescape(encodeURIComponent(JSON.stringify(this.state)))); }

  importSave(text: string): boolean {
    try {
      const s = JSON.parse(decodeURIComponent(escape(atob(text.trim())))) as GameState;
      if (s.v !== 1 || !s.char) return false;
      this.state = s;
      const sum = catchUp(this.state, this.data, Date.now());
      if (sum.ms >= REPORT_MIN_MS) this.away = sum;
      this.save();
      this.bump();
      return true;
    } catch { return false; }
  }

  // ---- subscription (useSyncExternalStore)
  subscribe = (l: Listener) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getVersion = () => this.version;
  onEvent(l: EventListener): () => void { this.eventListeners.add(l); return () => this.eventListeners.delete(l); }
  private bump(): void { this.version++; for (const l of this.listeners) l(); }

  dispose(): void { window.clearInterval(this.timer); }
}

function readSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as GameState;
    return s.v === 1 ? s : null;
  } catch { return null; }
}

export const game = new Game();
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
