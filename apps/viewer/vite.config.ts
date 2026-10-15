import { defineConfig } from 'vite';
import path from 'node:path';

// Converted assets are served straight from the local, gitignored cache. This viewer is a dev
// tool: never `vite build` it for distribution, since that would copy the cache into dist/.
export default defineConfig({
  publicDir: path.resolve(__dirname, '../../cache'),
  server: { port: 5173, strictPort: true },
});
