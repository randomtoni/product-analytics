import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanRepo,
  scanDoc,
  scanDeclarationBundles,
  scanJsBundles,
  stripComments,
  scanWireConfinementInSource,
  scanWireConfinement,
  isTestToolingFile,
  FORBIDDEN_TOKENS,
} from './neutrality-scan.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const README = join(REPO_ROOT, 'README.md');

// This test file IS the exit-nonzero CI gate (run via the root `neutrality-scan` turbo
// task, which builds all packages first so `dist/index.d.{ts,mts}` exist). A failing
// assertion here is a nonzero vitest exit — that IS the gate tripping.

describe('neutrality scan — current shipped tree PASSES', () => {
  it('finds zero violations across the real repo surface', () => {
    const violations = scanRepo({
      repoRoot: REPO_ROOT,
      packagesDir: PACKAGES_DIR,
      readmePath: README,
    });
    // Surface the detail so a real leak reads legibly in CI, not just a count.
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('does NOT trip on the 30 port-citation `//` comments (declaration dimension is comment-free)', () => {
    // The declaration bundle is what a consumer imports; `//` provenance comments never
    // reach it, so the `posthog` token in those comments is invisible to the gate.
    const declViolations = scanDeclarationBundles(PACKAGES_DIR);
    expect(declViolations).toEqual([]);
  });

  it('does NOT trip on the four `_WIRE_(EVENT|KEY)` consts (confined $-literals pass)', () => {
    const persistenceKeys = join(PACKAGES_DIR, 'browser/src/persistence-keys.ts');
    const wireViolations = scanWireConfinementInSource(
      persistenceKeys,
      readFileSync(persistenceKeys, 'utf8')
    );
    expect(wireViolations).toEqual([]);
  });

  it('does NOT trip on the unreachable wire-scan.test-helper.ts `$insert_id` literals', () => {
    const helper = join(PACKAGES_DIR, 'browser/src/wire-scan.test-helper.ts');
    // Directly confirm the classifier treats it as test-tooling (excluded from confinement).
    expect(isTestToolingFile(helper)).toBe(true);
    // And that the whole-tree confinement pass (which skips test-tooling) is clean —
    // the '$insert_id' literal in that unreachable helper never surfaces.
    expect(scanWireConfinement(PACKAGES_DIR)).toEqual([]);
  });

  it('scans BOTH .d.ts and .d.mts for every package (8 files, half the surface is .d.mts)', () => {
    // A planted token in the .d.mts sibling must be caught — prove the .mts arm is live.
    // We do this by asserting the real bundles are read (clean) AND that a synthetic
    // .d.mts-only violation is flagged in the planted-violation suite below.
    const declViolations = scanDeclarationBundles(PACKAGES_DIR);
    expect(declViolations).toEqual([]);
  });

  it('js-bundle dimension: the real rebuilt `dist/index.{js,mjs}` (8 files) PASSES', () => {
    // The compiled bundle is the artifact a consumer INSTALLS and can open — the ONE place
    // runtime wire VALUES (`kind: "HogQLQuery"`, `'$pageview'`) live after the `.d.ts` erases
    // them. The only `posthog` in dist JS is the surviving provenance COMMENT, which is
    // stripped before scanning; the confined query-kind values carry no vendor name → clean.
    const jsViolations = scanJsBundles(PACKAGES_DIR);
    expect(jsViolations, JSON.stringify(jsViolations, null, 2)).toEqual([]);
  });
});

describe('neutrality scan — planted violations FAIL', () => {
  // Synthetic package/repo trees under a temp dir — we NEVER plant in the real dist/README.
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const t of tmpRoots.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  function synthPackages(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'nscan-'));
    tmpRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return root;
  }

  it('flags a planted `posthog` in a declaration bundle (real scan code path, .d.ts)', () => {
    const root = synthPackages({
      'packages/seam/dist/index.d.ts': 'export declare class PosthogAdapter {}',
      'packages/seam/dist/index.d.mts': 'export declare class PosthogAdapter {}',
      'packages/seam/package.json': '{"name":"seam"}',
    });
    const violations = scanDeclarationBundles(join(root, 'packages'));
    expect(violations.some((v) => v.detail.includes('posthog'))).toBe(true);
  });

  it('js-bundle: flags a live vendor NAME value (posthog) shipped in dist/index.js', () => {
    const root = synthPackages({
      'packages/seam/dist/index.js':
        'const client = { name: "posthog" };\nmodule.exports = { client };\n',
      'packages/seam/dist/index.mjs': 'export const client = { name: "posthog" };\n',
      'packages/seam/package.json': '{"name":"seam"}',
    });
    const violations = scanJsBundles(join(root, 'packages'));
    expect(violations.map((v) => v.dimension)).toContain('js-bundle');
    expect(violations.some((v) => v.detail.includes('posthog'))).toBe(true);
  });

  it('js-bundle: flags a shipped `fernly` value and a hostname (`us.i.`) value', () => {
    const root = synthPackages({
      'packages/seam/dist/index.js': 'const p = "fernly";\nconst host = "us.i.example.com";\n',
      'packages/seam/dist/index.mjs': 'export const p = "fernly";\n',
      'packages/seam/package.json': '{"name":"seam"}',
    });
    const details = scanJsBundles(join(root, 'packages')).map((v) => v.detail).join();
    expect(details).toMatch(/fernly/i);
    expect(details).toMatch(/us\.i\./i);
  });

  it('js-bundle: a provenance COMMENT + a `kind: "HogQLQuery"` value PASSES (comment stripped, no name token)', () => {
    // Mirrors the real dist: the ONLY `posthog` is an audit provenance comment (stripped),
    // and the required wire vocab `HogQLQuery` carries no vendor name token → clean.
    const bundle =
      "// De-branded from posthog's query-node kinds — provenance, audit evidence.\n" +
      'const q = { kind: "HogQLQuery" };\nmodule.exports = { q };\n';
    const root = synthPackages({
      'packages/seam/dist/index.js': bundle,
      'packages/seam/dist/index.mjs': bundle.replace('module.exports = { q };', 'export { q };'),
      'packages/seam/package.json': '{"name":"seam"}',
    });
    expect(scanJsBundles(join(root, 'packages'))).toEqual([]);
  });

  it('js-bundle: catches a token planted ONLY in the .mjs sibling (proves BOTH extensions scanned)', () => {
    const root = synthPackages({
      'packages/seam/dist/index.js': 'module.exports = { ok: 1 };\n',
      'packages/seam/dist/index.mjs': 'export const brand = "posthog";\n',
      'packages/seam/package.json': '{"name":"seam"}',
    });
    const mjsHits = scanJsBundles(join(root, 'packages')).filter((v) =>
      v.file.endsWith('index.mjs')
    );
    expect(mjsHits).toHaveLength(1);
    expect(mjsHits[0].detail).toContain('posthog');
  });

  it('catches a token planted ONLY in the .d.mts sibling (proves BOTH extensions scanned)', () => {
    // .d.ts is clean; token lives only in .d.mts. Scanning only .d.ts would miss this.
    const root = synthPackages({
      'packages/seam/dist/index.d.ts': 'export declare const ok: number;',
      'packages/seam/dist/index.d.mts': 'export declare class PosthogClient {}',
      'packages/seam/package.json': '{"name":"seam"}',
    });
    const violations = scanDeclarationBundles(join(root, 'packages'));
    const mtsHits = violations.filter((v) => v.file.endsWith('.d.mts'));
    expect(mtsHits).toHaveLength(1);
    expect(mtsHits[0].detail).toContain('posthog');
  });

  it('flags a planted `fernly` in the README prose', () => {
    const leakedReadme = 'Adopt the library the way the Fernly demo app does.\n';
    const violations = scanDoc('README.md', leakedReadme);
    expect(violations.map((v) => v.detail).join()).toMatch(/fernly/i);
  });

  it('allows the ONE `examples/fernly` path form but still fails bare-prose `fernly`', () => {
    const pathOnly = 'See the runnable consumer under `examples/fernly` for a worked setup.\n';
    expect(scanDoc('README.md', pathOnly)).toEqual([]);

    const pathAndProse =
      'See `examples/fernly`. The Fernly app shows every config lever.\n';
    expect(scanDoc('README.md', pathAndProse).map((v) => v.detail).join()).toMatch(
      /fernly/i
    );
  });

  it('fails ALL non-fernly tokens in docs with no path carve-out', () => {
    expect(scanDoc('README.md', 'batch POST to i.posthog.com')).not.toEqual([]);
    expect(scanDoc('README.md', 'the ph_ cookie prefix')).not.toEqual([]);
    expect(scanDoc('README.md', 'us.i. region host')).not.toEqual([]);
  });

  it('flags a `$pageview` moved OUT of a `_WIRE_` const (escaped confinement)', () => {
    const escaped = `
      // some adapter code
      function emitPageview() {
        return { event: '$pageview' };
      }
    `;
    const violations = scanWireConfinementInSource('browser-adapter.ts', escaped);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toMatch(/\$pageview.*escaped/);
  });

  it('does NOT flag the same `$pageview` when it IS the value of a `_WIRE_EVENT` const', () => {
    const confined = `export const PAGEVIEW_WIRE_EVENT = '$pageview';\n`;
    expect(scanWireConfinementInSource('persistence-keys.ts', confined)).toEqual([]);
  });

  it('does NOT flag a `$`-token that appears only inside a `//` comment (literal-scoped, not text-scoped)', () => {
    const commentOnly = `
      // De-branded from posthog's $session_entry_url / $prev_pageview_duration / $geoip_disable
      export const SESSION_ENTRY_PROPS_KEY = 'session_entry_props';
    `;
    expect(scanWireConfinementInSource('persistence-keys.ts', commentOnly)).toEqual([]);
  });
});

describe('neutrality scan — bar-neutral & future-adapter invariants', () => {
  it('bar-neutral: PAGEVIEW_WIRE_EVENT (identifier) passes while its value $pageview is confined', () => {
    // The identifier carries zero vendor token → passes the declaration dimension check.
    expect(FORBIDDEN_TOKENS.some((t) => 'PAGEVIEW_WIRE_EVENT'.toLowerCase().includes(t))).toBe(
      false
    );
    // The value is permitted ONLY inside the confined const...
    expect(
      scanWireConfinementInSource('x.ts', `export const PAGEVIEW_WIRE_EVENT = '$pageview';`)
    ).toEqual([]);
    // ...and the same value FAILS the moment it leaves the const.
    expect(
      scanWireConfinementInSource('x.ts', `const x = '$pageview';`)
    ).not.toEqual([]);
  });

  it('future adapter: a NEW wire token passes with zero scan edits iff it obeys `_WIRE_(EVENT|KEY)`', () => {
    // A hypothetical future adapter's new confined wire const — no change to this scan.
    const futureConst = `export const SCREENVIEW_WIRE_EVENT = '$screenview';`;
    expect(scanWireConfinementInSource('future-adapter.ts', futureConst)).toEqual([]);
    // The same token, unconfined, still FAILS — the rule, not a whitelist, is what gates.
    expect(
      scanWireConfinementInSource('future-adapter.ts', `send('$screenview');`)
    ).not.toEqual([]);
    // A wire const whose IDENTIFIER carries a vendor token would still be caught by the
    // declaration dimension (identifier ships to dist); the confinement pass only governs
    // the value.
    const vendorNamedConst = `export const POSTHOG_WIRE_EVENT = '$foo';`;
    // Confinement itself passes (name obeys the convention)...
    expect(scanWireConfinementInSource('x.ts', vendorNamedConst)).toEqual([]);
    // ...but the identifier is a forbidden token, caught by the declaration scan.
    expect(FORBIDDEN_TOKENS.some((t) => 'POSTHOG_WIRE_EVENT'.toLowerCase().includes(t))).toBe(
      true
    );
  });

  it('future adapter: a NEW confined query KIND passes iff its const obeys `_WIRE_KIND`', () => {
    // The node builder hoisted query-node discriminators into `*_WIRE_KIND` consts; the
    // confinement convention now recognizes that suffix so a future adapter's new query kind
    // passes the SAME rule with zero scan edits. (These consts are not `$`-prefixed, so the
    // `$`-anchored AST pass doesn't visit them — the js-bundle NAME scan certifies the value;
    // the `_WIRE_KIND` widening is the forward-consistency arm of that same convention.)
    const confinedKind = `export const SCREENVIEW_WIRE_KIND = '$screenview_kind';`;
    expect(scanWireConfinementInSource('future-adapter.ts', confinedKind)).toEqual([]);
    // A `$`-prefixed kind value NOT held by a `_WIRE_` const still fails.
    expect(
      scanWireConfinementInSource('future-adapter.ts', `const k = '$screenview_kind';`)
    ).not.toEqual([]);
  });
});

describe('stripComments — parser-accurate, string-safe comment removal', () => {
  it('strips a `//` provenance comment while leaving code intact', () => {
    const src = `// De-branded from posthog's event-utils\nconst y = 2;\n`;
    const out = stripComments(src);
    expect(/posthog/i.test(out)).toBe(false);
    expect(out).toContain('const y = 2;');
  });

  it('preserves a `//` INSIDE a string literal (a URL like "http://yandex.com/bots")', () => {
    // The real hazard: `browser/dist/index.js` ships this bot-list URL as a VALUE. A naive
    // `//…EOL` regex strip would truncate the string and blind the scan.
    const src = `const url = "http://yandex.com/bots";\n// trailing comment\n`;
    const out = stripComments(src);
    expect(out).toContain('"http://yandex.com/bots"');
    expect(out).not.toContain('trailing comment');
  });

  it('does NOT mis-open a template literal on a lone backtick INSIDE a comment (the real desync)', () => {
    // The exact shape that broke a raw-scanner strip: a backtick in a `//` comment made the
    // context-free scanner start a template token that swallowed the `posthog` provenance as
    // string content. The full parser knows the backtick is comment trivia.
    const src =
      "// `capturePageleave` boolean when absent; disabled (posthog's default, de-branded)\n" +
      'const captureEnabled = true;\n';
    const out = stripComments(src);
    expect(/posthog/i.test(out)).toBe(false);
    expect(out).toContain('const captureEnabled = true;');
  });

  it('preserves line count so violation offsets stay legible', () => {
    const src = `const a = 1;\n// a comment\nconst b = 2;\n`;
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });
});
