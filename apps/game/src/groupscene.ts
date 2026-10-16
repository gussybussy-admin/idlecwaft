// The 3D scene for dungeon replays: the party (real looks and gear) on the left, the pull's creatures
// (real models) on the right, animated from the run's events.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildCharacter, type GearPiece, type Look } from './character.js';
import { buildClearing, displayEntry, loadGLTF , npcGear } from './diorama.js';

interface Actor { root: THREE.Object3D; mixer: THREE.AnimationMixer; clips: Map<string, THREE.AnimationClip>; base: string; current?: THREE.AnimationAction; dead?: boolean }
export interface PartyMember { look: Look | null; gear: GearPiece[] }

const PARTY_X = -2.2, MOB_X = 2.2;

export class GroupDiorama {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  private clock = new THREE.Clock();
  private party: (Actor | null)[] = [];
  private mobs = new Map<number, Actor>();
  private disposed = false;
  private ro: ResizeObserver;
  private token = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    host.prepend(this.renderer.domElement);
    buildClearing(this.scene, () => this.disposed);
    this.camera.position.set(0, 3.2, 8.5);
    this.camera.lookAt(0, 0.8, 0);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Positions on an arc: index i of n, on the given side. */
  private spot(i: number, n: number, x: number): THREE.Vector3 {
    const spread = Math.min(1.1, 4.4 / Math.max(1, n));
    const z = (i - (n - 1) / 2) * spread;
    return new THREE.Vector3(x - Math.abs(z) * 0.35 * Math.sign(x), 0, z);
  }

  async setParty(members: PartyMember[]) {
    for (const a of this.party) if (a) this.scene.remove(a.root);
    this.party = members.map(() => null);
    await Promise.all(members.map(async (m, i) => {
      const built = m.look ? await buildCharacter({ ...m.look, bake: null, geosets: {}, gear: m.gear }) : null;
      if (this.disposed) return;
      const actor = built ? this.actor(built.root, built.animations, built.durations) : this.placeholder(0x2a3a5a);
      // Raids (more than five on stage) stand in two rows: the first members (tanks, healers) in front.
      const cols = members.length > 5 ? Math.ceil(members.length / 2) : members.length;
      actor.root.position.copy(this.spot(i % cols, cols, PARTY_X - Math.floor(i / cols) * 1.6));
      actor.root.rotation.y = 0; // face the mobs (+x)
      this.scene.add(actor.root);
      this.party[i] = actor;
      this.play(actor, actor.base, true);
    }));
  }

  /** The mobs of a pull, by uid, with their creature display ids. */
  async setMobs(mobs: { uid: number; displayIds: number[]; equip?: [number, number][] }[]) {
    const token = ++this.token;
    for (const a of this.mobs.values()) this.scene.remove(a.root);
    this.mobs.clear();
    await Promise.all(mobs.map(async (m, i) => {
      let actor: Actor | null = null;
      for (const id of m.displayIds) {
        const entry = await displayEntry(id);
        if (!entry) continue;
        if (entry.humanoid) {
          const built = await buildCharacter({ ...entry.humanoid, gear: npcGear(m.equip) });
          if (built) actor = this.actor(built.root, built.animations, built.durations, entry.scale || 1);
        } else {
          const g = await loadGLTF(`creatures/${id}.glb`);
          if (g) {
            const root = cloneSkinned(g.scene);
            const defs = (g.parser.json.animations ?? []) as { extras?: { durationS?: number } }[];
            actor = this.actor(root, g.animations, defs.map(d => d.extras?.durationS), entry.scale || 1);
          }
        }
        if (actor) break;
      }
      if (token !== this.token || this.disposed) return;
      actor ??= this.placeholder(0x3a2a1a);
      actor.root.position.copy(this.spot(i, mobs.length, MOB_X));
      actor.root.rotation.y = Math.PI;
      this.scene.add(actor.root);
      this.mobs.set(m.uid, actor);
      this.play(actor, actor.base, true);
    }));
  }

  private actor(root: THREE.Object3D, animations: THREE.AnimationClip[], durations: (number | undefined)[], scale = 1): Actor {
    root.scale.multiplyScalar(scale);
    root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
    const clips = new Map<string, THREE.AnimationClip>();
    animations.forEach((c, i) => { const d = durations[i]; if (d) c.duration = d; clips.set(c.name, c); });
    const base = ['ReadyUnarmed', 'Ready1H', 'Stand'].find(n => clips.has(n)) ?? [...clips.keys()][0] ?? '';
    return { root, mixer: new THREE.AnimationMixer(root), clips, base };
  }

  private placeholder(color: number): Actor {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 6, 12), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.85;
    root.add(body);
    return { root, mixer: new THREE.AnimationMixer(root), clips: new Map(), base: '' };
  }

  private play(a: Actor, name: string, loop: boolean) {
    const clip = a.clips.get(name);
    if (!clip) return;
    const action = a.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.play();
    if (a.current && a.current !== action) a.current.crossFadeTo(action, 0.1, false);
    a.current = action;
    if (!loop && name !== 'Death') {
      const back = () => { a.mixer.removeEventListener('finished', back); if (a.current === action && !a.dead) this.play(a, a.base, true); };
      a.mixer.addEventListener('finished', back);
    }
  }
  private anim(a: Actor | null | undefined, names: string[], loop = false) {
    if (!a || a.dead) return;
    const n = names.find(x => a.clips.has(x));
    if (n) this.play(a, n, loop);
  }
  private get(who: number, mob: boolean) { return mob ? this.mobs.get(who) : this.party[who]; }

  attack(who: number, mob: boolean) { this.anim(this.get(who, mob), ['Attack1H', 'AttackUnarmed', 'Attack2H']); }
  cast(who: number, mob: boolean) { this.anim(this.get(who, mob), ['SpellCastDirected', 'SpellCastOmni', 'Attack1H']); }
  wound(who: number, mob: boolean) { this.anim(this.get(who, mob), ['CombatWound']); }
  die(who: number, mob: boolean) {
    const a = this.get(who, mob);
    if (!a || a.dead) return;
    this.anim(a, ['Death']);
    a.dead = true;
  }
  /** Everyone back on their feet (a new pull or a retry after a wipe). */
  reviveParty() { for (const a of this.party) if (a) { a.dead = false; this.play(a, a.base, true); } }

  /** Screen position above an actor (for floating numbers). */
  screenPos(who: number, mob: boolean): { x: number; y: number } | null {
    const a = this.get(who, mob);
    if (!a && !mob && who < 0) return null; // not on stage (raids show only some of the members)
    const p = a ? a.root.position.clone() : new THREE.Vector3(mob ? MOB_X : PARTY_X, 0, 0);
    p.y += 2.1;
    const v = p.project(this.camera);
    return { x: (v.x + 1) / 2 * this.host.clientWidth, y: (1 - v.y) / 2 * this.host.clientHeight };
  }

  private frame() {
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.25);
    for (const a of this.party) a?.mixer.update(dt);
    for (const a of this.mobs.values()) a.mixer.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
