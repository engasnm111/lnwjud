import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: desktopRoot,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
