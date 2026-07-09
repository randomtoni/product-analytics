import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import ts from 'typescript';

// The vendor/product-name neutrality gate (E11-S5). The whole reason the library
// exists is that no vendor name leaks into its consumer-observable SURFACE, so this
// is a durable, re-runnable, exit-nonzero check — NOT a manual grep.
//
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
    | 'package-name'
    | 'file-name'
    | 'doc'
    | 'wire-confinement';
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
// of a const whose exported identifier ends in `_WIRE_EVENT` or `_WIRE_KEY`. A future
// adapter's new wire token passes this SAME gate with ZERO scan edits iff it obeys the
// convention — this is the "scan gains no exceptions" invariant, encoded as a rule rather
// than a per-value whitelist. A per-value whitelist is REJECTED: it would ship a vendor-token
// registry in-repo and would need editing for every new adapter.
const WIRE_CONST_NAME = /_WIRE_(EVENT|KEY)$/;

function lowerIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function findForbidden(text: string): string[] {
  return FORBIDDEN_TOKENS.filter((tok) => lowerIncludes(text, tok));
}

// --- File-set helpers -------------------------------------------------------

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

// --- Dimension 1: declaration bundle (public identifier/type surface) --------

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

// --- Dimension 2/3: package.json names + file/dir names under packages/ ------

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

// --- Dimension 4: shipped docs (root README + S1 matrix + S2 guide) ----------

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

// --- Dimension 5: `$`-wire-literal confinement (AST over reachable src) ------

// Classify `$`-prefixed STRING LITERALS in one src file. Uses the TypeScript compiler AST
// so classification is literal-scoped, not text-scoped: a `$`-token inside a `//` comment
// (real port-citation comments contain `$session_entry_url`, `$prev_pageview_duration`,
// `$geoip_disable`) is NOT a string-literal node and is never visited here. A comment-strip
// regex pass would be the fallback if the compiler API were unavailable; the AST is
// strictly more correct (it also gives us the enclosing const's exported name for the
// confinement check) so we use it.
//
// A `$`-literal PASSES only when it is the initializer value of a const whose exported
// identifier matches `_WIRE_(EVENT|KEY)`. It FAILS anywhere else — an escaped-confinement
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
          detail: `wire literal "${node.text}" escaped a _WIRE_(EVENT|KEY) const`,
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

// --- The gate: run every dimension over the real repo tree -------------------

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
