// The built game client (HTML/JS/CSS only — our own code, no game art).
// In the packaged launcher, the build script replaces this module with the files embedded as base64.
// When running from source it is null and the launcher reads apps/game/dist from disk instead.
export const CLIENT_FILES: Record<string, string> | null = null;
