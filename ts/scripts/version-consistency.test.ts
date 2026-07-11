import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard against wire-stamp / public-version drift: the in-source version constants MUST equal
// the package.json version they ship under. Bumping a package.json without bumping its
// `export const version` (public surface) or, for browser, `LIBRARY_VERSION` (the wire `ver=`
// param + `lib_version` on every event) would ship a package that mis-reports its own version.
// This runs in the root gate (vitest.config.ts include: scripts/**/*.test.ts).

const TS_ROOT = join(import.meta.dirname, '..');

function pkgVersion(pkg: string): string {
  const p = JSON.parse(
    readFileSync(join(TS_ROOT, 'packages', pkg, 'package.json'), 'utf8')
  ) as { version: string };
  return p.version;
}

function extract(relPath: string, re: RegExp): string {
  const src = readFileSync(join(TS_ROOT, relPath), 'utf8');
  const m = src.match(re);
  if (!m) throw new Error(`no version constant matched in ${relPath}`);
  return m[1];
}

const PACKAGES = ['analytics-kit', 'browser', 'node', 'react'] as const;

describe('published version constants track package.json (no wire-stamp / surface drift)', () => {
  for (const pkg of PACKAGES) {
    it(`${pkg}: exported \`version\` === package.json version`, () => {
      const declared = extract(`packages/${pkg}/src/index.ts`, /export const version = '([^']+)'/);
      expect(declared).toBe(pkgVersion(pkg));
    });
  }

  it('browser: LIBRARY_VERSION (wire `ver=` + `lib_version`) === package.json version', () => {
    const declared = extract(
      'packages/browser/src/library-version.ts',
      /LIBRARY_VERSION = '([^']+)'/
    );
    expect(declared).toBe(pkgVersion('browser'));
  });
});
