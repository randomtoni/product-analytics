import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

// The load-bearing entry-boundary guard (no in-repo precedent): the base `@randomtoni/analytics-kit-browser`
// import must NOT pull rrweb into its module graph. rrweb (~100KB+) lives behind the separate
// `./replay` tsup entry, reached only through the recorder shell's dynamic `import('./replay')`,
// so esbuild code-splits it into `dist/replay.*` and leaves `dist/index.*` rrweb-free. The
// neutrality scan hardcodes `dist/index.*` and never reads `dist/replay.*`, so THIS test is the
// only guard that the split actually holds. Getting the boundary wrong later is breaking.
//
// It reads the built bundles; under the full gate `build` runs first, so `dist` is present. When
// run standalone (dist absent) it builds the package once as a self-healing fallback.
const distDir = join(__dirname, '..', 'dist');

// A `rrweb` MODULE import/require — the real leak signal. A bare `rrweb` substring is NOT: the
// shell's source comments mention rrweb by name and survive into the non-minified dev bundle, so
// the check must target the import statement, not the token.
const RRWEB_IMPORT = /(?:from\s*['"]rrweb['"]|require\(\s*['"]rrweb['"]\s*\))/;

function read(file: string): string {
  return readFileSync(join(distDir, file), 'utf8');
}

beforeAll(() => {
  if (!existsSync(join(distDir, 'index.js'))) {
    execSync('pnpm build', { cwd: join(__dirname, '..'), stdio: 'ignore' });
  }
});

describe('replay entry-boundary: rrweb stays out of the base bundle (E14-S2)', () => {
  test('emits both the base and replay entries (dual ESM + CJS)', () => {
    for (const file of ['index.js', 'index.mjs', 'replay.js', 'replay.mjs']) {
      expect(existsSync(join(distDir, file)), `${file} missing`).toBe(true);
    }
  });

  test('the base CJS bundle does not import rrweb', () => {
    expect(RRWEB_IMPORT.test(read('index.js'))).toBe(false);
  });

  test('the base ESM bundle does not import rrweb', () => {
    expect(RRWEB_IMPORT.test(read('index.mjs'))).toBe(false);
  });

  test('the replay entry DOES import rrweb (the code lives here, not in base)', () => {
    expect(RRWEB_IMPORT.test(read('replay.js'))).toBe(true);
    expect(RRWEB_IMPORT.test(read('replay.mjs'))).toBe(true);
  });

  test('the base entry reaches replay only via a dynamic import (the split boundary)', () => {
    // The recorder shell dynamic-imports the replay chunk; that reference is how the code is
    // kept out of the base graph. Its presence confirms the boundary is the dynamic import,
    // not a static one (a static import would inline rrweb into the base bundle).
    expect(read('index.mjs')).toMatch(/import\(\s*["']\.\/replay\.mjs["']\s*\)/);
    expect(read('index.js')).toMatch(/require\(\s*["']\.\/replay\.js["']\s*\)/);
  });

  test('the build emits NO shared chunk-* files (closes the transitive-via-chunk gap directly)', () => {
    // The "replay entry imports rrweb" / "base does not" pair only catches a rrweb-into-a-shared-
    // chunk regression incidentally (via the base-graph assertion). This asserts it directly: a
    // clean two-entry `splitting: true` build resolves each entry standalone and produces NO
    // `chunk-*` file, so any hoist of shared (rrweb-carrying) code into a common chunk shows up
    // here as a `chunk-*` artifact — the direct signal, not a transitive one.
    const chunks = readdirSync(distDir).filter((f) => f.startsWith('chunk-'));
    expect(chunks, `unexpected shared chunk(s): ${chunks.join(', ')}`).toEqual([]);
  });
});
