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

// Game data and converted assets are served from the player's local, gitignored cache.
// Don't `vite build` this for distribution while it points at the cache: dist/ would contain it.
export default defineConfig({
  plugins: [react(), devScreenshots()],
  publicDir: cacheDir,
  server: { port: 5174, strictPort: true },
});
