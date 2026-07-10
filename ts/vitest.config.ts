import { defineConfig } from 'vitest/config';

// Root config for the neutrality-scan gate ONLY. Pins `root` and an explicit `include`
// so this run never descends into `packages/*` to discover their configs or tests — the
// per-package suites stay owned by their own `packages/*/vitest.config.ts` (invoked by
// `turbo run test`, cwd = package dir). Deliberately defines NO `projects`/`workspace`.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['scripts/**/*.test.ts'],
  },
});
