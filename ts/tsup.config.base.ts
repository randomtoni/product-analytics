import type { Options } from 'tsup';

export const baseTsupConfig: Options = {
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
};
