import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['v1/tests/**/*.test.ts'],
  },
});
