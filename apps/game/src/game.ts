// Network client. The server is authoritative: it owns every character's state and the clock.
// The client keeps the latest server snapshot and replays the same deterministic sim locally up
// to "server now", which gives smooth animation without trusting anything the client computes.
import {
  advance, applyCommand, type Appearance, type ChatMessage, type ClientMessage, type Command, type FeedItem,
  type GameData, type GameState, type GuildSnapshot, type ServerMessage, type SimEvent, type Summary,
} from '@idle/sim';

const TICK_MS = 200;
const profile = new URLSearchParams(location.search).get('profile') ?? 'default';
const AUTH_KEY = `idlecwaft.auth.${profile}`;
const SERVER_KEY = 'idlecwaft.server';

type Listener = () => void;
type EventListener = (e: SimEvent) => void;
export type Phase = 'login' | 'connecting' | 'create' | 'playing';

function storageGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k: string, v: string | null): void { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } }

// The launcher opens the client with ?server=<guild server> so friends never type it.
const serverParam = new URLSearchParams(location.search).get('server');
if (serverParam) storageSet(SERVER_KEY, serverParam.replace(/\/+$/, ''));

export class Game {
  serverUrl = storageGet(SERVER_KEY) ?? (import.meta.env.VITE_SERVER_URL as string | undefined) ?? `http://${location.hostname}:7420`;
  phase: Phase = 'login';
  account: { id: number; username: string } | null = null;
  data!: GameData;
  state: GameState | null = null;
  guild: GuildSnapshot | null = null;
  away: Summary | null = null;
  toast: string | null = null;
  connected = false;
  unreadChat = 0;
  readingChat = false;

  private token = storageGet(AUTH_KEY);
  private ws: WebSocket | null = null;
  private offset = 0; // serverTime - Date.now()
  private lastEmitted = 0; // highest sim-event time already shown (snapshots can rewind a little)
  private nextId = 1;
  private pending = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  private version = 0;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();
  private timer: number | undefined;
  private retry = 0;
  private closing = false;

  get serverNow(): number { return Date.now() + this.offset; }

  /** Starts the session if a token is stored. */
  async start(): Promise<void> {
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    if (this.token) await this.connect();
    this.bump();
  }

  // ---------------------------------------------------------------- auth
  async auth(kind: 'login' | 'register', serverUrl: string, username: string, password: string): Promise<string | null> {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    storageSet(SERVER_KEY, this.serverUrl);
    try {
      const r = await fetch(`${this.serverUrl}/api/${kind}`, { method: 'POST', body: JSON.stringify({ username, password }) }).then(x => x.json());
      if (!r.ok) return r.error ?? 'Failed.';
      this.token = r.token;
      storageSet(AUTH_KEY, r.token);
      await this.connect();
      return null;
    } catch {
      return `Can't reach the server at ${this.serverUrl}.`;
    }
  }

  logout(): void {
    if (this.token) fetch(`${this.serverUrl}/api/logout`, { method: 'POST', body: JSON.stringify({ token: this.token }) }).catch(() => {});
    this.token = null;
    storageSet(AUTH_KEY, null);
    this.closing = true;
    this.ws?.close();
    this.state = null; this.guild = null; this.account = null;
    this.phase = 'login';
    this.bump();
  }

  // ---------------------------------------------------------------- connection
  private async connect(): Promise<void> {
    this.phase = this.state ? this.phase : 'connecting';
    this.bump();
    if (!this.data) {
      const res = await fetch(`${this.serverUrl}/api/gamedata`);
      if (!res.ok) throw new Error('The server has no game data.');
      this.data = await res.json();
    }
    this.closing = false;
    const ws = new WebSocket(this.serverUrl.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.send({ t: 'auth', token: this.token! }); };
    ws.onmessage = e => this.onMessage(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      this.connected = false;
      this.bump();
      if (this.closing || !this.token) return;
      const delay = Math.min(15_000, 1000 * 2 ** this.retry++);
      window.setTimeout(() => { if (this.token && !this.closing) this.connect().catch(() => {}); }, delay);
    };
  }

  private send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private request(m: ClientMessage & { id: number }): Promise<boolean> {
    return new Promise(resolve => {
      this.pending.set(m.id, r => { if (!r.ok && r.error) this.showToast(r.error); resolve(r.ok); });
      this.send(m);
      window.setTimeout(() => { if (this.pending.delete(m.id)) { this.showToast('The server did not answer.'); resolve(false); } }, 8000);
    });
  }

  private onMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'needCharacter': this.phase = 'create'; this.connected = true; break;
      case 'hello':
        this.account = m.account; this.guild = m.guild; this.connected = true;
        this.offset = m.serverTime - Date.now();
        this.phase = 'playing';
        break;
      case 'state':
        this.offset = m.serverTime - Date.now();
        this.state = m.state;
        this.lastEmitted = Math.max(this.lastEmitted, 0);
        break;
      case 'away': this.away = m.summary; break;
      case 'result': this.pending.get(m.id)?.(m); this.pending.delete(m.id); break;
      case 'guild': this.guild = m.guild; break;
      case 'chat': this.pushChat(m.msg); break;
      case 'feed': this.pushFeed(m.item); break;
      case 'error':
        this.showToast(m.error);
        if (/log in again/.test(m.error)) this.logout();
        break;
      case 'pong': this.offset = m.serverTime - Date.now(); break;
    }
    this.bump();
  }

  private pushChat(msg: ChatMessage) {
    if (!this.guild) return;
    this.guild.chat = [...this.guild.chat, msg].slice(-100);
    if (!this.readingChat && msg.who !== this.state?.char.name) this.unreadChat++;
  }
  private pushFeed(item: FeedItem) {
    if (!this.guild) return;
    this.guild.feed = [item, ...this.guild.feed].slice(0, 60);
  }

  /** Replay the sim up to server time; events already shown (before a resync) are not repeated. */
  private tick(): void {
    if (!this.state || !this.data) return;
    advance(this.state, this.data, this.serverNow, e => {
      if (e.t <= this.lastEmitted && e.type !== 'spawn') return;
      this.lastEmitted = Math.max(this.lastEmitted, e.t);
      for (const l of this.eventListeners) l(e);
    });
    this.bump();
  }

  // ---------------------------------------------------------------- actions
  createCharacter(name: string, race: number, cls: number, look?: Appearance): void {
    this.send({ t: 'create', name, race, cls, look });
  }

  /**
   * Sends a command to the server; it's applied locally right away and the server's snapshot confirms it.
   * A command the local preview rejects is still sent: the server decides (its rules may be newer than
   * this client's), and its answer shows the error if there really is one.
   */
  async command(cmd: Command): Promise<boolean> {
    if (!this.state) return false;
    applyCommand(this.state, this.data, cmd); // instant feedback; the server snapshot is the truth
    this.bump();
    return this.request({ t: 'cmd', id: this.nextId++, cmd });
  }

  bank(op: 'deposit' | 'withdraw', what: { item: number; count: number } | { gold: number }): Promise<boolean> {
    return this.request({ t: 'bank', id: this.nextId++, op, ...what });
  }
  createRequest(item: number, count: number, note: string): Promise<boolean> {
    return this.request({ t: 'request', id: this.nextId++, op: 'create', item, count, note });
  }
  fillRequest(request: number, count: number): Promise<boolean> {
    return this.request({ t: 'request', id: this.nextId++, op: 'fill', request, count });
  }
  cancelRequest(request: number): Promise<boolean> {
    return this.request({ t: 'request', id: this.nextId++, op: 'cancel', request });
  }
  createOrder(recipe: number, count: number, provide: boolean, tip: number, note: string): Promise<boolean> {
    return this.request({ t: 'order', id: this.nextId++, op: 'create', recipe, count, provide, tip, note });
  }
  orderOp(op: 'claim' | 'deliver' | 'cancel', order: number): Promise<boolean> {
    return this.request({ t: 'order', id: this.nextId++, op, order });
  }
  chat(text: string): void { this.send({ t: 'chat', text }); }
  markChatRead(reading: boolean): void { this.readingChat = reading; if (reading && this.unreadChat) { this.unreadChat = 0; this.bump(); } }

  showToast(text: string): void {
    this.toast = text;
    this.bump();
    window.setTimeout(() => { if (this.toast === text) { this.toast = null; this.bump(); } }, 3500);
  }
  dismissAway(): void { this.away = null; this.bump(); }

  // ---------------------------------------------------------------- subscription (useSyncExternalStore)
  subscribe = (l: Listener) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getVersion = () => this.version;
  onEvent(l: EventListener): () => void { this.eventListeners.add(l); return () => this.eventListeners.delete(l); }
  private bump(): void { this.version++; for (const l of this.listeners) l(); }

  dispose(): void { window.clearInterval(this.timer); this.closing = true; this.ws?.close(); }
}

export const game = new Game();
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
