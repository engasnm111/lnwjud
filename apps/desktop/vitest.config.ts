import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: desktopRoot,
  test: {
    environment: 'node',
    // Desktop acceptance files spawn real child processes and open SQLite-backed
    // runtimes. Letting Vitest fan out to every logical CPU creates lock/I/O
    // starvation on Windows and can make otherwise healthy 7-10s tests hit
    // 15-30s bounds. Cap file workers instead of inflating correctness timeouts.
    maxWorkers: 4,
    // SQLite-backed desktop fixtures exercise real restart/lock contention on
    // Windows, macOS, and Linux. Keep the timeout bounded but above the slowest
    // clean-machine I/O path observed by the cross-platform harness.
    testTimeout: process.env.CI ? 30_000 : 15_000,
    hookTimeout: process.env.CI ? 30_000 : 20_000,
    // SQLite fixtures own real files and WAL handles. Serializing test files
    // prevents unrelated fixtures from racing cleanup on slower hosts.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
