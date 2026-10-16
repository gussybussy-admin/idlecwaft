// The 3D combat diorama: a small Elwynn clearing with the real creature models from the player's
// client, animated from simulation events (swings, wounds, deaths).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildCharacter, type GearPiece, type HumanoidSpec, type Look } from './character.js';

interface ActorModel {
  root: THREE.Object3D; mixer: THREE.AnimationMixer; clips: Map<string, THREE.AnimationClip>;
  current?: THREE.AnimationAction; base: string; idle?: string;
}

export type Activity = 'idle' | 'combat' | 'mining' | 'herbalism' | 'fishing' | 'cooking' | 'crafting' | 'smithing' | 'enchanting'
  | 'travel' | 'quest' | 'rest' | 'eat' | 'dead';
const ACTIVITY_ANIMS: Record<Activity, string[]> = {
  idle: ['Stand'], combat: ['ReadyUnarmed', 'Stand'], mining: ['EmoteWorkNoSheathe', 'EmoteWork', 'Attack1H'],
  herbalism: ['KneelLoop', 'Loot'], fishing: ['FishingLoop', 'Stand'], cooking: ['KneelLoop', 'UseStandingLoop'],
  crafting: ['UseStandingLoop', 'KneelLoop'], smithing: ['EmoteWorkNoSheathe', 'EmoteWork', 'Attack1H'],
  enchanting: ['ChannelCastDirected', 'SpellCastOmni'], travel: ['Run', 'Walk'], quest: ['UseStandingLoop', 'Stand'],
  rest: ['SitGround', 'Stand'], eat: ['EmoteEatNoSheathe', 'EmoteEat', 'SitGround'], dead: ['Death'],
};


const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF | null>>();
export function loadGLTF(url: string): Promise<GLTF | null> {
  if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url).catch(() => null));
  return gltfCache.get(url)!;
}

export type DisplayEntry = { scale: number; humanoid?: HumanoidSpec };
const displayCache = new Map<number, Promise<DisplayEntry | null>>();
/** creatures/<id>.json (converted on first request by the launcher / dev server). */
export const displayEntry = (id: number) => {
  if (!displayCache.has(id)) displayCache.set(id, fetch(`creatures/${id}.json`).then(r => r.ok ? r.json() as Promise<DisplayEntry> : null).catch(() => null));
  return displayCache.get(id)!;
};

const MOB_X = 1.6, PLAYER_X = -1.6, PET_X = -0.3;
type Who = 'player' | 'mob' | 'pet';

/** The Elwynn clearing every scene stands in: sky, light, grass and dirt from the client, real trees. */
export function buildClearing(scene: THREE.Scene, isDisposed: () => boolean): void {
    const sky = new THREE.Color(0x9cc4e4);
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 14, 42);
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a2a, 1.4));
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.4);
    sun.position.set(-6, 10, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -6; sun.shadow.camera.right = 6; sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -6;
    scene.add(sun);

    // Ground: Elwynn grass tileset texture from the client.
    const tex = new THREE.TextureLoader().load('tiles/elwynngrassbase.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(24, 24);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshLambertMaterial({ map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const dirtTex = new THREE.TextureLoader().load('tiles/elwynndirtbase.png');
    dirtTex.wrapS = dirtTex.wrapT = THREE.RepeatWrapping;
    dirtTex.repeat.set(4, 4);
    dirtTex.colorSpace = THREE.SRGBColorSpace;
    const path = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48), new THREE.MeshLambertMaterial({ map: dirtTex, transparent: true, opacity: 0.85 }));
    path.rotation.x = -Math.PI / 2;
    path.position.y = 0.01;
    path.receiveShadow = true;
    scene.add(path);

    // A ring of real Elwynn trees behind the fight.
    // Elwynn's canopy trees are ~60 yards tall in the client; scaled down so they frame the scene.
    const trees: [string, number, number, number, number][] = [
      ['elwynntreecanopy01', -11, -14, 0.32, 0.3], ['elwynntreecanopy03', 10, -18, 0.22, 2.1], ['elwynnfirtree01', -18, -10, 0.45, 1.2],
      ['elwynntreecanopy01', 17, -9, 0.28, 4.0], ['elwynnfirtree01', 2, -22, 0.5, 0.8], ['elwynntreestump01', 3.8, -2.8, 0.5, 1.7],
      ['elwynntreecanopy03', -24, -24, 0.3, 5.1], ['elwynnfirtree01', 25, -20, 0.5, 2.8], ['elwynnfirtree01', -5, -26, 0.55, 3.3],
    ];
    for (const [name, x, z, s, ry] of trees) {
      loadGLTF(`doodads/${name}.glb`).then(g => {
        if (!g || isDisposed()) return;
        const obj = cloneSkinned(g.scene); // skinned meshes must be cloned with their skeleton
        obj.position.set(x, 0, z);
        obj.scale.setScalar(s);
        obj.rotation.y = ry;
        obj.traverse(o => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; for (const mat of ([] as THREE.Material[]).concat(m.material)) (mat as THREE.MeshStandardMaterial).alphaTest = 0.5; }
        });
        scene.add(obj);
      });
    }
}

export class Diorama {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  private clock = new THREE.Clock();
  private mob: ActorModel | null = null;
  private mobKey = '';
  private player: ActorModel | null = null;
  /** A hunter's beast or a warlock's demon, beside the player. */
  private pet: ActorModel | null = null;
  private petKey = '';
  private loadToken = 0;
  private disposed = false;
  private focused = document.hasFocus();
  private lastFrame = 0;
  private fadeOut: { actor: ActorModel; t: number } | null = null;
  private ro: ResizeObserver;

  private playerX: number;
  constructor(private host: HTMLElement, private opts: { preview?: boolean } = {}) {
    this.playerX = opts.preview ? 0 : PLAYER_X;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.prepend(this.renderer.domElement);
    this.buildScene();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    addEventListener('focus', this.onFocus);
    addEventListener('blur', this.onBlur);
    // Idle-friendly: full rate when focused, ~5 fps when blurred, nothing when the tab is hidden.
    this.renderer.setAnimationLoop(t => this.frame(t));
    if (import.meta.env.DEV) (window as unknown as { __dio: unknown }).__dio = { dio: this, THREE, scene: this.scene, camera: this.camera };
  }

  private onFocus = () => { this.focused = true; };
  private onBlur = () => { this.focused = false; };

  private buildScene() {
    buildClearing(this.scene, () => this.disposed);
    this.camera.position.set(0, 2.4, 7.5);
    this.camera.lookAt(0, 0.9, 0);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  /** Projects an actor's head position to host pixel coordinates (for floating combat text). */
  screenPos(who: Who): { x: number; y: number } {
    const actor = this.actor(who);
    const x = who === 'mob' ? MOB_X : who === 'pet' ? PET_X : this.playerX;
    let top = 1.8;
    if (actor) top = new THREE.Box3().setFromObject(actor.root).max.y;
    const v = new THREE.Vector3(x, top + 0.2, 0).project(this.camera);
    return { x: (v.x + 1) / 2 * this.host.clientWidth, y: (1 - v.y) / 2 * this.host.clientHeight };
  }

  /**
   * Shows the creature for `displayIds`: `pick` chooses which display this spawn uses (creatures can
   * have up to four). Humanoid displays are assembled from a race model. Null clears the mob.
   */
  async setMob(displayIds: number[] | null, pick = 0) {
    const key = displayIds ? `${displayIds.join(',')}#${pick}` : '';
    if (key === this.mobKey) return;
    this.mobKey = key;
    const token = ++this.loadToken;
    if (this.mob) { this.scene.remove(this.mob.root); this.mob = null; }
    if (!displayIds?.length) return;
    const model = await this.loadCreature(displayIds, pick);
    if (token !== this.loadToken || this.disposed || !model) return;
    // A new arrival replaces any corpse still sinking at the same spot.
    if (this.fadeOut) { this.scene.remove(this.fadeOut.actor.root); this.fadeOut = null; }
    model.root.position.set(MOB_X, 0, 0);
    model.root.rotation.y = Math.PI; // face the player
    this.scene.add(model.root);
    this.mob = model;
    this.play(model, model.base, true);
    this.frameCamera();
  }

  /** A creature model: this spawn's display first, then the others, until one converts. */
  private async loadCreature(displayIds: number[], pick = 0): Promise<ActorModel | null> {
    let id: number | undefined, entry: DisplayEntry | null = null;
    for (let i = 0; i < displayIds.length && !entry; i++) {
      id = displayIds[(pick + i) % displayIds.length];
      entry = await displayEntry(id);
    }
    if (entry?.humanoid) {
      const built = await buildCharacter(entry.humanoid);
      return built ? this.actorFrom(built.root, built.animations, built.durations, entry.scale || 1) : null;
    }
    if (entry) return this.loadActor(`creatures/${id}.glb`, entry.scale || 1);
    return this.placeholder(0x3a2a1a);
  }

  /** Your pet (a creature display id), or none. */
  async setPet(displayId: number | null) {
    const key = displayId ? String(displayId) : '';
    if (key === this.petKey) return;
    this.petKey = key;
    if (this.pet) { this.scene.remove(this.pet.root); this.pet = null; }
    if (!displayId) { this.frameCamera(); return; }
    const model = await this.loadCreature([displayId]);
    if (key !== this.petKey || this.disposed || !model) return;
    // Pets are shown at most player-sized (a tamed bear or a Voidwalker would fill the scene).
    const h = new THREE.Box3().setFromObject(model.root).getSize(new THREE.Vector3()).y;
    if (h > 1.6) model.root.scale.multiplyScalar(1.6 / h);
    model.root.position.set(PET_X, 0, 0.9);
    model.root.rotation.y = 0; // face the mob (+x)
    this.scene.add(model.root);
    this.pet = model;
    this.play(model, model.base, true);
    this.frameCamera();
  }
  /** The pet is back (revived or summoned again). */
  revivePet() { if (this.pet) this.play(this.pet, this.pet.base, true); }

  private actor(who: Who): ActorModel | null { return who === 'mob' ? this.mob : who === 'pet' ? this.pet : this.player; }

  // ---- props: what the character works at (an ore vein, an anvil, a campfire, water and a bobber)
  private prop: THREE.Object3D | null = null;
  private propKey = '';
  private water: THREE.Mesh | null = null;
  /** Shows a game object (GameObjectDisplayInfo id) where the mob would stand, plus water for fishing. */
  async setProp(displayId: number | null, opts: { water?: boolean; scale?: number } = {}) {
    const key = `${displayId}:${!!opts.water}`;
    if (key === this.propKey) return;
    this.propKey = key;
    if (this.prop) { this.scene.remove(this.prop); this.prop = null; }
    if (opts.water && !this.water) {
      const w = new THREE.Mesh(new THREE.CircleGeometry(3.2, 48), new THREE.MeshPhongMaterial({ color: 0x2d5f86, transparent: true, opacity: 0.85, shininess: 80 }));
      w.rotation.x = -Math.PI / 2;
      w.position.set(MOB_X + 1.6, 0.02, -0.6);
      this.water = w;
      this.scene.add(w);
    } else if (!opts.water && this.water) { this.scene.remove(this.water); this.water = null; }
    if (displayId == null) { this.frameCamera(); return; }
    const g = await loadGLTF(`objects/${displayId}.glb`);
    if (!g || this.disposed || key !== this.propKey) return;
    const obj = cloneSkinned(g.scene);
    obj.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; for (const mat of ([] as THREE.Material[]).concat(m.material)) (mat as THREE.MeshStandardMaterial).alphaTest = 0.5; }
    });
    // Fit very large or tiny objects to roughly character size.
    const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    const big = Math.max(size.x, size.y, size.z) || 1;
    obj.scale.setScalar((opts.scale ?? 1) * (big > 3 ? 2.2 / big : big < 0.4 ? 0.8 / big : 1));
    // Work props stand within arm's reach of the character; the bobber floats out on the water.
    obj.position.set(opts.water ? MOB_X + 1.2 : this.playerX + 1.3, opts.water ? 0.05 : 0, opts.water ? -0.4 : 0);
    this.prop = obj;
    this.scene.add(obj);
    this.frameCamera();
  }

  /** A short "picked something up" kneel (gathering, skinning a corpse). */
  harvest() {
    const n = this.first(this.player, ['Loot', 'KneelStart']);
    if (this.player && n) this.play(this.player, n, false, 0.1);
  }

  private playerKey = '';
  async setPlayer(look: Look | null, gear: GearPiece[] = []) {
    const key = JSON.stringify([look, gear]);
    if (key === this.playerKey) return;
    this.playerKey = key;
    const built = look ? await buildCharacter({ ...look, bake: null, geosets: {}, gear }) : null;
    if (this.disposed || key !== this.playerKey) return;
    if (this.player) { this.scene.remove(this.player.root); this.player = null; }
    const model = built ? this.actorFrom(built.root, built.animations, built.durations, 1) : this.placeholder(0x2a3a5a);
    model.root.position.set(this.playerX, 0, 0);
    if (this.opts.preview) model.root.rotation.y = -Math.PI / 2; // face the camera
    this.scene.add(model.root);
    this.player = model;
    this.setActivity(this.activity, true);
    this.frameCamera();
  }

  /** What the player is doing, which picks their idle animation. */
  private activity: Activity = 'idle';
  setActivity(a: Activity, force = false) {
    if (a === this.activity && !force) return;
    this.activity = a;
    const p = this.player;
    if (!p) return;
    const name = this.first(p, ACTIVITY_ANIMS[a]) ?? p.base;
    if (name) this.play(p, name, a !== 'dead');
    p.idle = name;
  }

  private actorFrom(root: THREE.Object3D, animations: THREE.AnimationClip[], durations: (number | undefined)[], scale: number): ActorModel {
    root.scale.setScalar(scale);
    const clips = new Map<string, THREE.AnimationClip>();
    animations.forEach((c, i) => { const d = durations[i]; if (d) c.duration = d; clips.set(c.name, c); });
    const base = ['ReadyUnarmed', 'Stand'].find(n => clips.has(n)) ?? [...clips.keys()][0] ?? '';
    return { root, mixer: new THREE.AnimationMixer(root), clips, base };
  }

  private async loadActor(url: string, scale: number): Promise<ActorModel | null> {
    const g = await loadGLTF(url);
    if (!g) return null;
    const root = cloneSkinned(g.scene);
    root.scale.setScalar(scale);
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.frustumCulled = false;
      for (const mat of ([] as THREE.Material[]).concat(m.material)) {
        const blend = (mat.userData as { wowBlendMode?: number }).wowBlendMode ?? 0;
        if (blend === 3 || blend === 4) { mat.blending = THREE.AdditiveBlending; mat.depthWrite = false; mat.transparent = true; }
      }
    });
    const defs = (g.parser.json.animations ?? []) as { extras?: { durationS?: number } }[];
    const clips = new Map<string, THREE.AnimationClip>();
    g.animations.forEach((c, i) => { const d = defs[i]?.extras?.durationS; if (d) c.duration = d; clips.set(c.name, c); });
    const base = ['ReadyUnarmed', 'Stand'].find(n => clips.has(n)) ?? [...clips.keys()][0] ?? '';
    return { root, mixer: new THREE.AnimationMixer(root), clips, base };
  }

  private placeholder(color: number): ActorModel {
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 6, 12), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.85;
    body.castShadow = true;
    root.add(body);
    return { root, mixer: new THREE.AnimationMixer(root), clips: new Map(), base: '' };
  }

  private play(a: ActorModel, name: string, loop: boolean, fade = 0.12) {
    const clip = a.clips.get(name);
    if (!clip) return;
    const action = a.mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.play();
    if (a.current && a.current !== action) a.current.crossFadeTo(action, fade, false);
    a.current = action;
    if (!loop && name !== 'Death') {
      const back = () => { a.mixer.removeEventListener('finished', back); if (a.current === action) this.play(a, a.idle ?? a.base, true); };
      a.mixer.addEventListener('finished', back);
    }
  }

  private first(a: ActorModel | null, names: string[]): string | null {
    return a ? names.find(n => a.clips.has(n)) ?? null : null;
  }

  // ---- event hooks from the simulation
  attack(who: Who) {
    const a = this.actor(who);
    const n = this.first(a, ['AttackUnarmed', 'Attack1H', 'Attack2H']);
    if (a && n) this.play(a, n, false, 0.08);
  }
  wound(who: Who, crit: boolean) {
    const a = this.actor(who);
    const n = this.first(a, crit ? ['CombatCritical', 'CombatWound'] : ['CombatWound']);
    if (a && n) this.play(a, n, false, 0.05);
  }
  dodge(who: Who) {
    const a = this.actor(who);
    const n = this.first(a, ['Dodge', 'ParryUnarmed']);
    if (a && n) this.play(a, n, false, 0.05);
  }
  die(who: Who) {
    const a = this.actor(who);
    const n = this.first(a, ['Death']);
    if (a && n) this.play(a, n, false, 0.1);
    if (who === 'mob' && a) {
      if (this.fadeOut) this.scene.remove(this.fadeOut.actor.root);
      this.fadeOut = { actor: a, t: 2.4 };
      this.mobKey = '';
      this.mob = null;
    }
  }
  revive() { this.setActivity('rest', true); }

  private frameCamera() {
    const box = new THREE.Box3();
    for (const a of [this.mob, this.player, this.pet]) if (a) box.expandByObject(a.root);
    if (this.prop) box.expandByObject(this.prop);
    if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 2, 1));
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const fitH = size.y / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const fitW = size.x / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const dist = Math.max(fitH, fitW, 3) * 1.35 + 2;
    this.camera.position.set(center.x * 0.3, center.y + dist * 0.18 + 0.4, dist);
    this.camera.lookAt(center.x * 0.3, center.y * 0.8, 0);
  }

  private frame(t: number) {
    if (document.hidden) return;
    if (!this.focused && t - this.lastFrame < 200) return;
    this.lastFrame = t;
    const dt = Math.min(this.clock.getDelta(), 0.25);
    this.mob?.mixer.update(dt);
    this.player?.mixer.update(dt);
    this.pet?.mixer.update(dt);
    if (this.opts.preview && this.player) this.player.root.rotation.y += dt * 0.4; // slow turntable
    if (this.fadeOut) {
      // The corpse keeps animating (Death holds its last frame), then sinks into the ground.
      const f = this.fadeOut;
      f.t -= dt;
      f.actor.mixer.update(dt);
      if (f.t <= 0) { this.scene.remove(f.actor.root); this.fadeOut = null; }
      else if (f.t < 0.8) f.actor.root.position.y = -(0.8 - f.t) * 0.6;
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    removeEventListener('focus', this.onFocus);
    removeEventListener('blur', this.onBlur);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
