import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['convex/**/*.spec.ts', 'src/**/*.spec.{ts,tsx}'],
  },
});
