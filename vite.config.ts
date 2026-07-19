import { defineConfig } from 'vite';

export default defineConfig(() => {
  // Tauri automatically sets this environment variable when it builds
  const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

  return {
    // If it's Tauri, use the root path. If not, use the GitHub Pages path!
    base: isTauri ? '/' : '/pcr-dropout-checker/',
  };
});
