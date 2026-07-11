import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.config.base';

// Two entries: the base target (`src/index.ts` → `dist/index.*`) and the replay target
// (`src/replay/index.ts` → `dist/replay.*`, the `@randomtoni/analytics-kit-browser/replay` subpath).
// The object entry form pins each output name so `src/replay/index.ts` emits the FLAT
// `dist/replay.*` (not `dist/replay/index.*`) and never collides with `dist/index.*`.
// `splitting` keeps the heavy rrweb code out of BOTH the ESM and CJS base bundles: the
// recorder shell (base graph) reaches the replay body only through a dynamic import, so
// with code-splitting on, rrweb lands solely in `dist/replay.*`. Without it, the CJS base
// bundle would inline the dynamic import and pull rrweb into `dist/index.js`.
export default defineConfig({
  ...baseTsupConfig,
  entry: { index: 'src/index.ts', replay: 'src/replay/index.ts' },
  splitting: true,
});
