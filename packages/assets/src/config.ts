// Locates the user's own client. Paths come from idle.config.json (gitignored) or env vars.
import fs from 'node:fs';
import path from 'node:path';

export interface IdleConfig { clientPath: string; cacheDir: string }

export function findRepoRoot(start = process.cwd()): string {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'idle.config.example.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(start);
  }
}

export function loadConfig(overrides: Partial<IdleConfig> = {}): IdleConfig {
  const root = findRepoRoot();
  const file = path.join(root, 'idle.config.json');
  const fromFile: Partial<IdleConfig> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const clientPath = overrides.clientPath ?? process.env.IDLE_CLIENT_PATH ?? fromFile.clientPath;
  if (!clientPath) throw new Error('No client path. Copy idle.config.example.json to idle.config.json, or pass --client <path>.');
  const cacheDir = path.resolve(root, overrides.cacheDir ?? process.env.IDLE_CACHE_DIR ?? fromFile.cacheDir ?? 'cache');
  if (!fs.existsSync(path.join(clientPath, 'Data'))) throw new Error(`No Data folder in client path: ${clientPath}`);
  return { clientPath, cacheDir };
}
