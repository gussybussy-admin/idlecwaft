import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const cacheDir = path.resolve(__dirname, '../../cache');

/**
 * Dev-only: POST a canvas data URL to /__dev/screenshot?name=foo and it is saved to
 * cache/screenshots/foo.jpg (gitignored). Lets automated checks capture the 3D scene even
 * when the browser tab is in the background.
 */
function devScreenshots(): Plugin {
  return {
    name: 'dev-screenshots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/screenshot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '');
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const m = body.match(/^data:image\/(png|jpeg);base64,(.+)$/);
          if (!m) { res.statusCode = 400; res.end('expected a data URL'); return; }
          const dir = path.join(cacheDir, 'screenshots');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${name}.${m[1] === 'png' ? 'png' : 'jpg'}`);
          fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
          res.end(file);
        });
      });
    },
  };
}

/**
 * Dev-only: creature models and item icons that aren't in the cache yet are converted from the local
 * client on first request (the launcher does the same for players).
 */
function lazyArt(): Plugin {
  return {
    name: 'lazy-art',
    apply: 'serve',
    async configureServer(server) {
      const { loadConfig } = await import('../../packages/assets/src/config.js');
      const { Client } = await import('../../packages/assets/src/client.js');
      const { LazyArt } = await import('../../packages/assets/src/convert/lazy.js');
      let art: InstanceType<typeof LazyArt> | null = null;
      server.middlewares.use((req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!/^(icons\/[\w-]+\.png|creatures\/\d+\.(json|glb)|objects\/\d+\.glb|sounds\/\d+(\.json|-\d+\.(wav|mp3))|items\/\d+(\.json|-(left|right)(-[a-z]{2}[mf])?\.glb))$/i.test(rel) || fs.existsSync(path.join(cacheDir, rel))) return next();
        try { art ??= new LazyArt(new Client(loadConfig().clientPath), cacheDir); } catch { return next(); }
        const body = art.get(rel);
        if (!body) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', rel.endsWith('.png') ? 'image/png' : rel.endsWith('.json') ? 'application/json'
          : rel.endsWith('.wav') ? 'audio/wav' : rel.endsWith('.mp3') ? 'audio/mpeg' : 'model/gltf-binary');
        res.end(body);
      });
    },
  };
}

// The dev server serves converted art from the player's local, gitignored cache. Production builds
// (used by the launcher) get NO public dir, so no cache file can ever end up in dist/: the launcher
// serves each player's own cache next to the build at runtime.
export default defineConfig(({ command }) => ({
  plugins: [react(), devScreenshots(), lazyArt()],
  publicDir: command === 'serve' ? cacheDir : false,
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
}));
