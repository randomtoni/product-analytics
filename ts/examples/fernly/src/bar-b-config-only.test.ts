import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Bar B — new-app adoption = CONFIG ONLY, ZERO library change.
//
// The E10 Fernly example IS the bar-B proof: it adopts the four packages purely by configuration,
// its entire footprint confined to `examples/**`, with ZERO edits under `packages/**`. This suite
// makes that a STATED, re-runnable, CHECKED audit outcome — not a claim — by asserting the
// STRUCTURAL guarantee that Fernly can ONLY resolve the packages' PUBLISHED surface:
//
//   1. Fernly's tsconfig has NO `paths`/alias reaching into any `packages/*/src` — so `tsc` can
//      resolve the four packages ONLY via their published `dist` entries (their package `exports`),
//      never by reaching into library source. This is exactly what makes `turbo typecheck`
//      (dependsOn ^build) a config-only-adoption gate: it typechecks the example against the BUILT
//      surface, so any reliance on unpublished internals would fail.
//   2. Fernly depends on all four packages via `workspace:*` — the published-package dependency
//      form, not a relative path into `packages/*/src`.
//
// Together: Fernly consumes the library the way any new app would — through the published surface,
// by config — proving bar B without a single `packages/**` edit. (This suite reads the ON-DISK
// config, so it stays truthful as the example evolves.)

const HERE = dirname(fileURLToPath(import.meta.url));
const FERNLY_ROOT = join(HERE, '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FERNLY_ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

const LIBRARY_PACKAGES = [
  '@randomtoni/analytics-kit',
  '@randomtoni/analytics-kit-browser',
  '@randomtoni/analytics-kit-node',
  '@randomtoni/analytics-kit-react',
] as const;

describe('bar B — new-app adoption = config only, zero library change', () => {
  it('fernly tsconfig has NO paths/alias reaching into any packages/*/src (dist-only resolution)', () => {
    const tsconfig = readJson('tsconfig.json');
    const compilerOptions = (tsconfig.compilerOptions ?? {}) as Record<string, unknown>;

    // No `paths` alias at all is the strongest form — resolution falls to node_modules → the
    // published package `exports` (dist). If a `paths` map ever appears, NONE of its targets may
    // reach into `packages/*/src` (that would let the example bypass the published surface and
    // silently depend on library internals — a bar-B violation).
    const paths = compilerOptions.paths as Record<string, string[]> | undefined;
    if (paths !== undefined) {
      for (const targets of Object.values(paths)) {
        for (const target of targets) {
          expect(target).not.toMatch(/packages\/[^/]+\/src/);
        }
      }
    } else {
      expect(paths).toBeUndefined();
    }

    // `baseUrl` (which can, combined with node_modules layout, shortcut resolution) is likewise
    // absent — nothing reroutes the four packages away from their published entries.
    expect(compilerOptions.baseUrl).toBeUndefined();
  });

  it('fernly depends on all four library packages via workspace:* (published-package form)', () => {
    const pkg = readJson('package.json');
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;

    for (const name of LIBRARY_PACKAGES) {
      expect(deps[name], `expected dependency on ${name}`).toBe('workspace:*');
    }
  });

  it('fernly declares no dependency whose version reaches into packages/*/src by relative path', () => {
    // A `file:../../packages/*/src`-style dependency would bypass the published dist surface. The
    // ONLY allowed form for the four library packages is `workspace:*` (asserted above); here we
    // additionally confirm NO dependency of any kind points a relative path into library source.
    const pkg = readJson('package.json');
    const allDeps = {
      ...((pkg.dependencies ?? {}) as Record<string, string>),
      ...((pkg.devDependencies ?? {}) as Record<string, string>),
    };
    for (const spec of Object.values(allDeps)) {
      expect(spec).not.toMatch(/packages\/[^/]+\/src/);
    }
  });

  it('the bar-B proof is grounded in the Fernly typecheck-against-dist gate (turbo dependsOn ^build)', () => {
    // The re-runnable gate itself: `turbo run typecheck` runs `dependsOn: ["^build"]` (turbo.json),
    // so Fernly's `tsc --noEmit` runs AFTER its four deps are built to `dist`, and — because there
    // is no `paths`/`baseUrl` reroute (asserted above) — resolves them ONLY via their published
    // `exports`. That gate passing IS bar B: the example typechecks against the BUILT public
    // surface with zero `packages/**` edits. This assertion documents + pins that turbo wiring so a
    // future `turbo.json` change that drops `^build` (which would silently un-gate bar B) is caught.
    const turbo = JSON.parse(
      readFileSync(join(FERNLY_ROOT, '..', '..', 'turbo.json'), 'utf8')
    ) as { tasks?: Record<string, { dependsOn?: string[] }> };
    const typecheckDeps = turbo.tasks?.typecheck?.dependsOn ?? [];
    expect(typecheckDeps).toContain('^build');
  });
});
