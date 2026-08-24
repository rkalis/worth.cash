import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      lib: resolve(import.meta.dirname, './lib'),
      components: resolve(import.meta.dirname, './components'),
      app: resolve(import.meta.dirname, './app'),
    },
  },
  test: {
    // Node by default; the hook tests opt into jsdom via a per-file docblock, since a DOM is only needed
    // for those and booting one for every file slows the suite down for no reason.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
