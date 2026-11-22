import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

import { forbidInlineCode } from './tooling/forbidInlineCode.ts';

export default defineConfig({
  plugins: [react(), forbidInlineCode()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  css: {
    preprocessorOptions: {
      scss: { additionalData: "@use '@/styles/shared' as *;\n" },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
