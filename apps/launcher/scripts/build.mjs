// Builds dist/launcher/IdlecraftLauncher.exe: the game client (our code only) + the art converter +
// a tiny local web server, as one Node single-executable application (SEA).
//
// Safety check: the embedded client build must contain only HTML/JS/CSS. Any image, model, font,
// texture or data file in it means Blizzard-derived content leaked into the build, and we stop.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const out = path.join(root, 'dist/launcher');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });

// 1. Build the game client without any public dir (vite.config.ts guarantees that for builds).
run(npm, ['run', 'build', '-w', '@idle/game']);
const distDir = path.join(root, 'apps/game/dist');
const files = {};
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    const rel = path.relative(distDir, full).replace(/\\/g, '/');
    if (!/\.(html|js|css|map)$/i.test(rel)) throw new Error(`Refusing to embed ${rel}: client builds must not contain game assets.`);
    files[rel] = fs.readFileSync(full).toString('base64');
  }
};
walk(distDir);
console.log(`embedding client build: ${Object.keys(files).join(', ')}`);

// 2. Bundle the launcher into one CommonJS file, with the client build swapped into client-files.ts.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'launcher.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'apps/launcher/src/main.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, minify: true,
  external: ['better-sqlite3'], // never reached from the launcher; listed so a mistake fails loudly
  plugins: [{
    name: 'embed-client',
    setup(b) {
      b.onLoad({ filter: /client-files\.ts$/ }, () => ({
        contents: `export const CLIENT_FILES = ${JSON.stringify(files)};`, loader: 'js',
      }));
    },
  }],
});
const code = fs.readFileSync(bundle, 'utf8');
if (code.includes('better-sqlite3')) throw new Error('The launcher bundle references better-sqlite3; it must not pull in the importer.');
console.log(`bundle: ${(code.length / 1024).toFixed(0)} KB`);

// 3. Node SEA: blob -> copy of node.exe -> inject.
const exe = path.join(out, process.platform === 'win32' ? 'IdlecraftLauncher.exe' : 'idlecraft-launcher');
const seaConfig = path.join(out, 'sea-config.json');
const blob = path.join(out, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', seaConfig], { shell: false });
fs.copyFileSync(process.execPath, exe);
run(process.execPath, [path.join(root, 'node_modules/postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { shell: false });
for (const f of [seaConfig, blob, bundle]) fs.rmSync(f);
console.log(`\nbuilt ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(0)} MB)`);

// The committed copy friends download from GitHub (contains only our code + the Node runtime).
if (process.platform === 'win32') {
  const committed = path.join(root, 'release', path.basename(exe));
  fs.mkdirSync(path.dirname(committed), { recursive: true });
  fs.copyFileSync(exe, committed);
  console.log(`copied to ${path.relative(root, committed)} — commit it to publish the new version`);
}
