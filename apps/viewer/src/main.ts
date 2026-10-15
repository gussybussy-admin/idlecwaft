// Phase 1 viewer: loads converted creatures from the local cache and plays their M2 animations.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface ManifestEntry { displayId: number; model: string; file: string; scale: number; skins: string[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSelect = $<HTMLSelectElement>('model'), animsEl = $('anims'), statusEl = $('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2a2c);
scene.fog = new THREE.Fog(0x1b2a2c, 12, 30);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// A small lakeshore diorama: the kind of spot a Murloc camp sits on.
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a2e1c, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
sun.position.set(4, 8, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshStandardMaterial({ color: 0x6b5a3a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const water = new THREE.Mesh(new THREE.RingGeometry(4, 30, 64), new THREE.MeshStandardMaterial({ color: 0x1f4f5c, roughness: 0.25, metalness: 0.1 }));
water.rotation.x = -Math.PI / 2;
water.position.y = -0.05;
scene.add(water);

const loader = new GLTFLoader();
const clock = new THREE.Clock();
let mixer: THREE.AnimationMixer | null = null;
let current: THREE.Object3D | null = null;
let currentAction: THREE.AnimationAction | null = null;

function applyWowMaterials(root: THREE.Object3D) {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds don't follow animation
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
      const blend = (m.userData as { wowBlendMode?: number }).wowBlendMode ?? 0;
      if (blend === 3 || blend === 4) { m.blending = THREE.AdditiveBlending; m.depthWrite = false; m.transparent = true; }
    }
  });
}

async function loadModel(entry: ManifestEntry) {
  statusEl.textContent = `loading ${entry.file}…`;
  const t0 = performance.now();
  const gltf: GLTF = await loader.loadAsync(entry.file);
  if (current) scene.remove(current);
  current = gltf.scene;
  current.scale.setScalar(entry.scale || 1);
  applyWowMaterials(current);
  scene.add(current);

  mixer = new THREE.AnimationMixer(current);
  // GLTFLoader doesn't copy animation extras onto clips; read the M2 sequence length from the JSON.
  const animDefs = (gltf.parser.json.animations ?? []) as { extras?: { durationS?: number } }[];
  const clips = gltf.animations.map((c, i) => {
    const d = animDefs[i]?.extras?.durationS;
    if (d) c.duration = d;
    return c;
  });
  animsEl.replaceChildren(...clips.map(clip => {
    const b = document.createElement('button');
    b.textContent = clip.name;
    b.onclick = () => play(clip, b);
    return b;
  }));
  const stand = clips.find(c => c.name === 'Stand') ?? clips[0];
  if (stand) play(stand, animsEl.children[clips.indexOf(stand)] as HTMLButtonElement);

  // Frame the model from its bounding box.
  const box = new THREE.Box3().setFromObject(current);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const dist = Math.max(size.x, size.y, size.z) * 2.2;
  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.8, center.y + dist * 0.35, center.z + dist * 0.8);
  controls.update();

  const ms = (performance.now() - t0).toFixed(0);
  statusEl.textContent = `${entry.model}\nskin: ${entry.skins.join(', ') || '—'}\n${clips.length} animations · loaded in ${ms} ms`;
}

function play(clip: THREE.AnimationClip, button: HTMLButtonElement) {
  if (!mixer) return;
  const next = mixer.clipAction(clip);
  // Death holds its last frame; everything else loops like the client does.
  const once = /^Death/.test(clip.name);
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  next.clampWhenFinished = once;
  next.reset().play();
  if (currentAction && currentAction !== next) currentAction.crossFadeTo(next, 0.15, false);
  currentAction = next;
  for (const b of animsEl.children) b.classList.toggle('on', b === button);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// Idle-friendly rendering: full rate when focused, ~4 fps when the window is blurred,
// and nothing at all while the tab is hidden (rAF stops by itself).
let focused = document.hasFocus();
addEventListener('focus', () => (focused = true));
addEventListener('blur', () => (focused = false));
let last = 0;
renderer.setAnimationLoop(t => {
  if (!focused && t - last < 250) return;
  last = t;
  const dt = Math.min(clock.getDelta(), 0.25);
  mixer?.update(dt);
  controls.update();
  renderer.render(scene, camera);
});

// Displays to show: ?ids=31,188,346 (each needs creatures/<id>.json in the cache: npm run assets -- creature <id>).
const ids = (new URLSearchParams(location.search).get('ids') ?? '31,188,346').split(',').map(Number).filter(Boolean);
const manifest: Record<string, ManifestEntry> = {};
for (const id of ids) {
  const e = await fetch(`creatures/${id}.json`).then(r => r.ok ? r.json() as Promise<ManifestEntry> : null).catch(() => null);
  if (e?.file) manifest[id] = e;
}
const entries = Object.values(manifest);
if (!entries.length) {
  statusEl.textContent = 'No converted creatures in the cache.\nRun: npm run assets -- creature 31';
} else {
  modelSelect.replaceChildren(...entries.map(e => new Option(`${e.displayId} · ${e.model.split('\\').pop()} (${e.skins[0] ?? '—'})`, String(e.displayId))));
  modelSelect.onchange = () => loadModel(manifest[modelSelect.value]);
  await loadModel(entries[0]);
}
