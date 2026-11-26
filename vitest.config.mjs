import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/worker.test.mjs'],
    environment: 'node',
  },
});
