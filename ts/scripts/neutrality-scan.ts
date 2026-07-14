import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import ts from 'typescript';

// Why NOT a raw `grep` over `packages/**` (architect-locked): a raw text grep is the
// WRONG tool and would false-fail on three legitimate categories that live in the tree
// by design —
//   1. the ~30 port-provenance `//` comments ("De-branded from posthog's event-utils.ts")
//      — dev-facing audit evidence that the port was de-branded, not surface;
//   2. the confined `$`-prefixed [WIRE] literals ('$pageview' etc.) that ride events but
//      never cross onto the neutral surface;
//   3. `$`-tokens appearing INSIDE those provenance comments.
// So the scan classifies by DIMENSION (what a consumer can observe), not by raw text:
// the identifier/type/package dimension is read off the emitted declaration bundle
// (comments + non-exported internals simply aren't in it), and the `$`-wire-literal
// confinement is an AST pass over `src` (string literals only — a `$`-token in a comment
// is not a literal). Anyone reaching for `grep -r` should read this and stop.

export interface Violation {
  dimension:
    | 'declaration'
    | 'js-bundle'
    | 'package-name'
    | 'file-name'
    | 'doc'
    | 'wire-confinement'
    | 'driver-static-import';
  file: string;
  detail: string;
}

// Case-insensitive vendor/product tokens forbidden on the surface. Region hostnames are
// listed as their distinctive host fragments. `fernly` is the E10 invented product name —
// it belongs ONLY in the `examples/fernly` path, never in the library surface or in prose.
export const FORBIDDEN_TOKENS: readonly string[] = [
  'posthog',
  'ph_',
  'i.posthog.com',
  'us.i.',
  'eu.i.',
  'fernly',
];

// The confinement convention: a `$`-prefixed wire literal is PERMITTED only as the value
// of a const whose exported identifier ends in `_WIRE_EVENT`, `_WIRE_KEY`, or `_WIRE_KIND`.
// A future adapter's new wire token passes this SAME gate with ZERO scan edits iff it obeys
// the convention — this is the "scan gains no exceptions" invariant, encoded as a rule rather
// than a per-value whitelist. A per-value whitelist is REJECTED: it would ship a vendor-token
// registry in-repo and would need editing for every new adapter. `_WIRE_KIND` covers the
// node query-node discriminators (`EventsNode`, `TrendsQuery`, …) hoisted into confined
// consts; those are NOT `$`-prefixed so this `$`-anchored AST pass never visits them — the
// widening is for forward-consistency, and the js-bundle NAME scan is what actually certifies
// that shipped query vocab carries no vendor token.
const WIRE_CONST_NAME = /_WIRE_(EVENT|KEY|KIND)$/;

function lowerIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function findForbidden(text: string): string[] {
  return FORBIDDEN_TOKENS.filter((tok) => lowerIncludes(text, tok));
}

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Skip the vendored reference checkout, build output, and deps everywhere.
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

// A `src` test-tooling file. This filename set is an APPROXIMATION of the true invariant
// "is this file reachable from the package's public `index.ts` entry (i.e. does its code
// ship to `dist`)?". The precise invariant is import-graph reachability, and a genuine
// escaped `$`-literal in real adapter code IS reachable from the entry so it still FAILS.
// A full module-graph walk (resolving the `analytics-kit` workspace alias + `.ts`
// extension resolution) is more than this gate should carry, so we enumerate the
// test-tooling patterns actually present under `src`. It MUST include `*.test-helper.ts`,
// not just `*.test.ts` — `browser/src/wire-scan.test-helper.ts` holds `'$insert_id'`
// literals but is imported only by tests and never ships; a `*.test.ts`-only exemption
// would false-fail on it.
export function isTestToolingFile(path: string): boolean {
  const name = basename(path);
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx') ||
    name.endsWith('.test-helper.ts')
  );
}

// tsup rolls each package up into ONE declaration bundle: `dist/index.d.ts` AND its
// `dist/index.d.mts` sibling (8 files total across 4 packages). There are NO per-source
// `.d.ts` files. Both extensions are distinct SHIPPED files — a consumer resolving the
// ESM `types` condition reads `.d.mts` — so scanning only `.d.ts` silently skips HALF the
// declaration surface. Scan BOTH. This bundle IS the public surface by construction:
// non-exported internals and `//` comments' `posthog` provenance never reach it.
export function scanDeclarationBundles(packagesDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const distDir = join(packagesDir, pkg, 'dist');
    for (const ext of ['index.d.ts', 'index.d.mts']) {
      const file = join(distDir, ext);
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        // The bundle must exist — the gate runs after `build`. A missing bundle is
        // itself a failure (we cannot certify a surface we cannot read).
        violations.push({
          dimension: 'declaration',
          file,
          detail: `declaration bundle missing — build must run before the scan`,
        });
        continue;
      }
      for (const tok of findForbidden(content)) {
        violations.push({
          dimension: 'declaration',
          file,
          detail: `forbidden token "${tok}" in published declaration surface`,
        });
      }
    }
  }
  return violations;
}

// Strip every comment from bundle text, leaving string literals intact. This is the crux of
// the js-bundle dimension: a de-branding PROVENANCE comment ("De-branded from posthog's …")
// survives tsup/esbuild into `dist/*.js` (empirically verified — esbuild keeps them), and it
// is audit evidence, exempt by the SAME logic the declaration dimension already applies to
// `//` comments. A live vendor NAME as a runtime VALUE must still fail. We CANNOT use a naive
// `//…$`/`/*…*/` regex: `dist/index.js` ships string literals containing `//` (e.g. the
// real `"http://yandex.com/bots"` bot-list value in the browser bundle) that a text regex
// would corrupt, silently blinding the scan.
//
// We also can't use the raw `ts.createScanner` (context-free): a lone backtick INSIDE a `//`
// comment (real case — the provenance comment `` `capturePageleave` boolean … (posthog's ``)
// makes the scanner mis-open a template literal that swallows thousands of chars — comment and
// all — as string content, silently blinding the scan. Only the full parser has the context
// to know that backtick is comment trivia. So we PARSE with `ts.createSourceFile` and collect
// comment ranges via `ts.getLeadingCommentRanges`/`getTrailingCommentRanges` walked over every
// token position (these ranges are parser-accurate — never string-literal or template bytes),
// then blank exactly those ranges. Newlines inside a comment are preserved so line numbers
// don't shift and violation detail stays legible.
export function stripComments(source: string): string {
  const sf = ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, true);
  const ranges: ts.CommentRange[] = [];

  const collect = (pos: number): void => {
    for (const r of ts.getLeadingCommentRanges(source, pos) ?? []) ranges.push(r);
    for (const r of ts.getTrailingCommentRanges(source, pos) ?? []) ranges.push(r);
  };

  const visit = (node: ts.Node): void => {
    collect(node.getFullStart());
    node.forEachChild(visit);
  };
  visit(sf);
  collect(sf.endOfFileToken.getFullStart());

  // Blank the collected comment ranges (keeping newlines). Dedup by start so leading/trailing
  // overlaps at a boundary don't double-count; apply right-to-left so earlier offsets hold.
  const seen = new Set<number>();
  const unique = ranges
    .filter((r) => (seen.has(r.pos) ? false : (seen.add(r.pos), true)))
    .sort((a, b) => b.pos - a.pos);

  let out = source;
  for (const r of unique) {
    const blanked = out.slice(r.pos, r.end).replace(/[^\n]/g, '');
    out = out.slice(0, r.pos) + blanked + out.slice(r.end);
  }
  return out;
}

// tsup emits each package as `dist/index.js` (CJS) AND `dist/index.mjs` (ESM) — 8 files
// across 4 packages, mirroring the dual-file declaration loop. Unlike `.d.ts`, these bundles
// carry RUNTIME VALUES: a `kind: "HogQLQuery"` literal or a `'$pageview'` string ships here,
// type-erased out of the declaration surface — so this is the ONLY dimension that certifies
// what a consumer actually opens in `node_modules`. We strip comments first (provenance is
// exempt audit evidence, per `stripComments`), then scan for the vendor NAME tokens. The
// required wire vocabulary (`HogQLQuery`, `TrendsQuery`, `$pageview`, …) carries NO name
// token, so legitimately-shipped confined wire values pass for free — no exemption needed.
export function scanJsBundles(packagesDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const distDir = join(packagesDir, pkg, 'dist');
    for (const ext of ['index.js', 'index.mjs']) {
      const file = join(distDir, ext);
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        // The bundle must exist — the gate runs after `build`. A missing bundle is itself a
        // failure (we cannot certify an artifact we cannot read).
        violations.push({
          dimension: 'js-bundle',
          file,
          detail: `js bundle missing — build must run before the scan`,
        });
        continue;
      }
      for (const tok of findForbidden(stripComments(content))) {
        violations.push({
          dimension: 'js-bundle',
          file,
          detail: `forbidden token "${tok}" as a value in published js bundle`,
        });
      }
    }
  }
  return violations;
}

// The optional Postgres driver the node package's default `DbExecute` loads. It is a peer dep,
// NOT a hard dependency: importing the node package WITHOUT it installed must not throw, so the
// driver is loaded LAZILY via variable-indirection (`var DRIVER_MODULE = 'pg'` +
// `await import(DRIVER_MODULE)`) — esbuild cannot statically resolve the specifier, so it ships
// as a runtime `import(DRIVER_MODULE)` with NO literal `pg` inside the call. This constant names
// the driver here so the guard is a one-line edit if the default driver ever changes.
const NODE_LAZY_DRIVER = 'pg';

// A static top-level import/require of the driver with a STRING-LITERAL specifier — the exact
// forms esbuild emits for `import ... from 'pg'` / `require('pg')` / `import('pg')` in the built
// bundle. Anchored on the call/keyword so it matches ONLY a literal-specifier form: the shipped
// lazy `await import(DRIVER_MODULE)` (variable) has no `pg` literal inside the call and PASSES,
// and the bare `var DRIVER_MODULE = "pg"` assignment + the `pg_input_is_valid` SQL token both
// lack the `require(`/`from`/`import(` anchor so neither false-fails.
function staticDriverImportRegex(driver: string): RegExp {
  const d = driver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\bfrom|\\brequire\\s*\\(|\\bimport\\s*\\()\\s*['"]${d}['"]`);
}

// Fail the gate if the node package's BUILT bundle statically imports the optional driver. This
// guards the import-without-peer invariant: a future edit re-adding a top-level `import ... from
// 'pg'` would make `require('@randomtoni/analytics-kit-node')` throw when the peer is absent, and
// nothing else catches it. Scans the SHIPPED `dist/index.{js,mjs}` (the CJS + ESM entries) — the
// artifact a consumer actually loads — mirroring the `scanJsBundles` dual-file loop. Comments are
// stripped first so a `// … 'pg' …` provenance note can't trip it; the shipped lazy
// variable-indirection form carries no literal-specifier call and PASSES for free.
export function scanNodeDriverStaticImport(packagesDir: string): Violation[] {
  const violations: Violation[] = [];
  const distDir = join(packagesDir, 'node', 'dist');
  const pattern = staticDriverImportRegex(NODE_LAZY_DRIVER);
  for (const ext of ['index.js', 'index.mjs']) {
    const file = join(distDir, ext);
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      violations.push({
        dimension: 'driver-static-import',
        file,
        detail: `node bundle missing — build must run before the scan`,
      });
      continue;
    }
    if (pattern.test(stripComments(content))) {
      violations.push({
        dimension: 'driver-static-import',
        file,
        detail: `static "${NODE_LAZY_DRIVER}" import in node bundle — the optional driver must load lazily via await import(DRIVER_MODULE), never a top-level import/require`,
      });
    }
  }
  return violations;
}

export function scanPackageAndFileNames(packagesDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const pkgRoot = join(packagesDir, pkg);
    if (!statSync(pkgRoot).isDirectory()) continue;

    const pkgJsonPath = join(pkgRoot, 'package.json');
    let name = '';
    try {
      name = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name ?? '';
    } catch {
      /* no package.json — nothing to name-check */
    }
    for (const tok of findForbidden(name)) {
      violations.push({
        dimension: 'package-name',
        file: pkgJsonPath,
        detail: `forbidden token "${tok}" in package name "${name}"`,
      });
    }

    for (const file of walk(pkgRoot, () => true)) {
      const rel = relative(packagesDir, file);
      for (const tok of findForbidden(rel.split(sep).join('/'))) {
        violations.push({
          dimension: 'file-name',
          file,
          detail: `forbidden token "${tok}" in path segment`,
        });
      }
    }
  }
  return violations;
}

// Docs have NO internal exemption: EVERY forbidden token including `fernly` fails in prose.
// The ONE allowed doc form of `fernly` is inside an `examples/fernly` PATH segment (S1/S2
// reference the example only as a filesystem path/link). We encode that carve-out precisely
// by stripping `examples/fernly` occurrences before the `fernly` check, so a path-link
// passes while a BARE prose `fernly` still FAILS. All OTHER tokens (posthog, ph_, hostnames)
// have no doc carve-out at all.
export function scanDoc(docPath: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const withoutExamplePath = content.replace(/examples\/fernly/gi, '');
  for (const tok of FORBIDDEN_TOKENS) {
    const haystack = tok.toLowerCase() === 'fernly' ? withoutExamplePath : content;
    if (lowerIncludes(haystack, tok)) {
      violations.push({
        dimension: 'doc',
        file: docPath,
        detail:
          tok.toLowerCase() === 'fernly'
            ? `forbidden token "fernly" in prose (only an "examples/fernly" path link is allowed)`
            : `forbidden token "${tok}" in shipped doc`,
      });
    }
  }
  return violations;
}

// Classify `$`-prefixed STRING LITERALS in one src file. Uses the TypeScript compiler AST
// so classification is literal-scoped, not text-scoped: a `$`-token inside a `//` comment
// (real port-citation comments contain `$session_entry_url`, `$prev_pageview_duration`,
// `$geoip_disable`) is NOT a string-literal node and is never visited here. A comment-strip
// regex pass would be the fallback if the compiler API were unavailable; the AST is
// strictly more correct (it also gives us the enclosing const's exported name for the
// confinement check) so we use it.
//
// A `$`-literal PASSES only when it is the initializer value of a const whose exported
// identifier matches `_WIRE_(EVENT|KEY|KIND)`. It FAILS anywhere else — an escaped-confinement
// leak (e.g. someone inlining '$pageview' in an adapter instead of importing the const).
export function scanWireConfinementInSource(filePath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.startsWith('$')) {
      if (!isConfinedWireLiteral(node)) {
        violations.push({
          dimension: 'wire-confinement',
          file: filePath,
          detail: `wire literal "${node.text}" escaped a _WIRE_(EVENT|KEY|KIND) const`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function isConfinedWireLiteral(literal: ts.StringLiteralLike): boolean {
  // The literal must be the direct initializer of a `const NAME = '$...'` whose exported
  // NAME obeys the wire-const convention. `export const` at top level, or a bare const the
  // module re-exports, both surface an Identifier we can test.
  const parent = literal.parent;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== literal) return false;
  if (!ts.isIdentifier(parent.name)) return false;
  return WIRE_CONST_NAME.test(parent.name.text);
}

// The confinement pass runs ONLY over `src` files that ship (reachable from the package's
// `index.ts` entry). We approximate reachability by excluding test-tooling files — see
// `isTestToolingFile`. This is why `wire-scan.test-helper.ts`'s `'$insert_id'` literal
// does NOT trip the scan: it is imported only by tests and never reaches `dist`.
export function scanWireConfinement(packagesDir: string): Violation[] {
  const violations: Violation[] = [];
  const srcFiles = walk(packagesDir, (p) => {
    if (!/\.tsx?$/.test(p)) return false;
    if (!p.includes(`${sep}src${sep}`)) return false;
    return !isTestToolingFile(p);
  });
  for (const file of srcFiles) {
    violations.push(...scanWireConfinementInSource(file, readFileSync(file, 'utf8')));
  }
  return violations;
}

// REJECTED, and why (leave this here so it doesn't resurface): scrubbing the port-citation
// `// De-branded from posthog's …` comments in `packages/**/src`. They are dev-facing
// provenance — load-bearing audit evidence that the port was DE-BRANDED rather than copied,
// the very thing this epic reviews — identical in kind to the `planning/` / `CLAUDE.md`
// citations the epic already exempts. They never reach `dist` (so they are absent from the
// declaration dimension) and they are not docs, so this scan does NOT read non-doc `//`
// comments in `src` for the `posthog` token at all.

export interface RepoScanPaths {
  repoRoot: string;
  packagesDir: string;
  readmePath: string;
  // Extra shipped docs S1/S2 add later land as more README-adjacent files; add them here
  // and they pass the SAME doc gate with zero other edits.
  extraDocPaths?: string[];
}

// SELF-SCAN gotcha (handled structurally): this scan file NAMES the forbidden tokens
// ("posthog", "fernly", the hostnames) as its own match patterns, so it would self-fail
// if it were ever scanned. It never is: every dimension is anchored to `packagesDir`
// (declarations, package/file names, wire confinement) or to the shipped doc paths
// (README) — `scripts/` is under none of them, so the scan code is excluded from its own
// scan by construction. Keep this file OUT of `packages/**` and it stays self-clean.
export function scanRepo(paths: RepoScanPaths): Violation[] {
  const violations: Violation[] = [];
  violations.push(...scanDeclarationBundles(paths.packagesDir));
  violations.push(...scanJsBundles(paths.packagesDir));
  violations.push(...scanNodeDriverStaticImport(paths.packagesDir));
  violations.push(...scanPackageAndFileNames(paths.packagesDir));
  violations.push(...scanWireConfinement(paths.packagesDir));

  const docFiles = [paths.readmePath, ...(paths.extraDocPaths ?? [])];
  for (const doc of docFiles) {
    let content: string;
    try {
      content = readFileSync(doc, 'utf8');
    } catch {
      continue;
    }
    violations.push(...scanDoc(doc, content));
  }
  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  [${v.dimension}] ${v.file}\n      ${v.detail}`)
    .join('\n');
}
