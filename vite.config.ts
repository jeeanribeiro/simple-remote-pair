import { defineConfig } from 'vite';
import { remotePairServer } from './src/server/dev-plugin.js';

export default defineConfig({
  plugins: [remotePairServer()],
  server: {
    host: true,
  },
  build: {
    outDir: 'dist/client',
    target: 'es2023',
    sourcemap: true,
  },
});
