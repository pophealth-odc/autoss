import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repository>/, so the built files must use
 * "/<repository>/" as their base path. The deployment workflow sets VITE_BASE; locally it stays "/".
 */
export function normalizeBase(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: normalizeBase(process.env['VITE_BASE'] ?? env['VITE_BASE']),
    plugins: [react(), tailwindcss()],
    server: {
      // 5173 may be taken by another program; Vite then picks the next free port and prints it.
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: false,
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 600,
    },
  };
});
