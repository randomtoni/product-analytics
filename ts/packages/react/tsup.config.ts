import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseTsupConfig,
  // Next.js App Router only honors the client-boundary directive when it sits in the BUILT
  // output; tsup/esbuild drops source-file directives when bundling.
  banner: { js: "'use client';" },
});
