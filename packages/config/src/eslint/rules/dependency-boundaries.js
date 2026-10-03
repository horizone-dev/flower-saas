/**
 * dependency-boundaries
 *
 * Architecture dependency-direction rule (replaces `eslint-plugin-boundaries`' `dependencies` rule, whose
 * `micromatch` -> `braces` dependency path carries an unpatched advisory and has no upstream fix).
 *
 * A model of ELEMENTS (a type + a path glob, optionally capturing path segments) and POLICIES (which element
 * types an element type may import) is supplied as rule options — the same data shape the shared factory has
 * always exported as BOUNDARY_ELEMENTS / BOUNDARY_POLICIES. For every import, the importing file and the
 * resolved target file are each classified into at most one element (first matching element wins). Then:
 *
 *   - either side unclassified (outside `include`, not matching an element, a node built-in, a third-party
 *     package, or a specifier that does not resolve to a file)  -> ignored;
 *   - same element INSTANCE (same type and same captured segments, e.g. two files of one domain module)
 *                                                                -> allowed;
 *   - otherwise a policy for the importing type must list the target type; default is DISALLOW.
 *
 * Checked: `import` (incl. `import type`, inline `type`, side-effect), `export … from`, `export * from`,
 * `import('literal')` and `require('literal')`. Resolution is deterministic and cwd-independent: relative
 * specifiers resolve against the importing file (TypeScript `.js` -> `.ts` aware, directory indexes); bare
 * specifiers resolve through `node_modules` (workspace links), exactly like a declared dependency would.
 *
 * Pattern syntax is a deliberately small glob subset — `*`, `**`, `(a|b)` — and anything else is rejected at
 * load time rather than silently mis-matching. `*` / `**` never match a leading-dot segment (glob default).
 */
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\?*]/g, '\\$&');
const UNSUPPORTED = /[{}[\]!?+@]/;

/**
 * Compiles a glob (see header) to `{ regex, groups }`. Groups are numbered in order of appearance over the
 * wildcards `*`, `**` and `(a|b)` and are what an element's `capture` names refer to.
 */
export function compilePattern(pattern) {
  if (UNSUPPORTED.test(pattern)) {
    throw new Error(`dependency-boundaries: unsupported glob syntax in pattern "${pattern}"`);
  }
  const segments = pattern.split('/');
  let source = '^';
  let groups = 0;
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === '**') {
      if (i === 0)
        throw new Error(`dependency-boundaries: unsupported leading ** in pattern "${pattern}"`);
      groups += 1;
      // a trailing `/**` needs at least one more segment (only files are ever classified, never
      // directories); a middle `**/` matches zero or more directories
      source += last ? '((?:/(?!\\.)[^/]+)+)' : '/((?:(?!\\.)[^/]+/)*)';
      return;
    }
    const afterGlobstar = i > 0 && segments[i - 1] === '**';
    if (i > 0 && !afterGlobstar) source += '/';
    let body = seg.startsWith('*') ? '(?!\\.)' : '';
    for (let k = 0; k < seg.length; k += 1) {
      const ch = seg[k];
      if (ch === '*') {
        if (seg[k + 1] === '*')
          throw new Error(
            `dependency-boundaries: unsupported "**" inside a segment of "${pattern}"`,
          );
        groups += 1;
        body += seg === '*' ? '([^/]+)' : '([^/]*)';
      } else if (ch === '(') {
        const end = seg.indexOf(')', k);
        if (end < 0 || (k > 0 && '*'.includes(seg[k - 1]))) {
          throw new Error(
            `dependency-boundaries: unsupported group syntax in pattern "${pattern}"`,
          );
        }
        const alts = seg.slice(k + 1, end).split('|');
        if (alts.some((a) => a.includes('*') || a.includes('(') || a === '')) {
          throw new Error(
            `dependency-boundaries: unsupported group syntax in pattern "${pattern}"`,
          );
        }
        groups += 1;
        body += `(${alts.map(escapeRe).join('|')})`;
        k = end;
      } else if (ch === ')' || ch === '|') {
        throw new Error(`dependency-boundaries: unsupported group syntax in pattern "${pattern}"`);
      } else {
        body += escapeRe(ch);
      }
    }
    source += body;
  });
  return { regex: new RegExp(`${source}$`), groups };
}

/** `{ captures }` (the wildcard groups, in order) when `file` matches, else null. */
export function matchPattern(compiled, file) {
  const m = compiled.regex.exec(file);
  if (!m) return null;
  return { captures: m.slice(1).map((g) => (g ?? '').replace(/^\/+|\/+$/g, '')) };
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Resolves a relative specifier the way a TypeScript (NodeNext) source file means it; null if no file. */
function resolveRelative(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  const ext = path.extname(base);
  if (isFile(base)) return base;
  for (const swap of JS_TO_TS[ext] ?? []) {
    const candidate = base.slice(0, -ext.length) + swap;
    if (isFile(candidate)) return candidate;
  }
  for (const e of SOURCE_EXTENSIONS) if (isFile(base + e)) return base + e;
  for (const e of SOURCE_EXTENSIONS) {
    const index = path.join(base, `index${e}`);
    if (isFile(index)) return index;
  }
  return null;
}

const BUILTINS = new Set(builtinModules);

/** Resolves a bare specifier through node_modules; returns a representative file of a NON-external package. */
function resolveBare(fromDir, spec) {
  if (spec.startsWith('node:') || spec.startsWith('#') || path.isAbsolute(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!name || BUILTINS.has(name)) return null;
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (isFile(manifest)) {
      const real = fs.realpathSync(path.dirname(manifest));
      const external = real.split(path.sep).includes('node_modules');
      return external ? null : path.join(real, 'package.json');
    }
    if (path.dirname(dir) === dir) return null;
  }
}

function findWorkspaceRoot(startDir, fallback) {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (isFile(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (path.dirname(dir) === dir) return fallback;
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Architecture dependency direction: an element may only import the element types its policy allows.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          default: { enum: ['disallow'] },
          rootDir: { type: 'string' },
          include: { type: 'array', items: { type: 'string' } },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                pattern: { type: 'string' },
                capture: { type: 'array', items: { type: 'string' } },
              },
              required: ['type', 'pattern'],
              additionalProperties: false,
            },
          },
          policies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: {
                  type: 'object',
                  properties: {
                    element: {
                      type: 'object',
                      properties: { type: { type: 'string' } },
                      required: ['type'],
                      additionalProperties: false,
                    },
                  },
                  required: ['element'],
                  additionalProperties: false,
                },
                allow: {
                  type: 'object',
                  properties: {
                    to: {
                      type: 'object',
                      properties: {
                        element: {
                          type: 'object',
                          properties: {
                            type: { type: 'string' },
                            types: {
                              type: 'object',
                              properties: { anyOf: { type: 'array', items: { type: 'string' } } },
                              required: ['anyOf'],
                              additionalProperties: false,
                            },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ['element'],
                      additionalProperties: false,
                    },
                  },
                  required: ['to'],
                  additionalProperties: false,
                },
              },
              required: ['from', 'allow'],
              additionalProperties: false,
            },
          },
        },
        required: ['elements', 'policies'],
        additionalProperties: false,
      },
    ],
    messages: {
      noPolicy:
        'There is no policy allowing dependencies from elements of type "{{from}}" to elements of type "{{to}}"',
    },
  },

  create(context) {
    const options = context.options[0];
    const elements = options.elements.map((e) => ({ ...e, compiled: compilePattern(e.pattern) }));
    const include = (options.include ?? []).map(compilePattern);
    const known = new Set(elements.map((e) => e.type));
    const allowed = new Map(); // importing element type -> Set of allowed target types
    for (const p of options.policies) {
      const fromType = p.from.element.type;
      const to = p.allow.to.element;
      const toTypes = to.types ? to.types.anyOf : to.type === undefined ? [] : [to.type];
      if (toTypes.length === 0) {
        throw new Error(
          'dependency-boundaries: a policy must name at least one target element type',
        );
      }
      for (const t of [fromType, ...toTypes]) {
        if (!known.has(t))
          throw new Error(`dependency-boundaries: policy references unknown element type "${t}"`);
      }
      const set = allowed.get(fromType) ?? new Set();
      for (const t of toTypes) set.add(t);
      allowed.set(fromType, set);
    }

    const filename = context.filename;
    if (!filename || filename.startsWith('<')) return {};
    const fromDir = path.dirname(filename);
    const root = options.rootDir
      ? path.resolve(options.rootDir)
      : findWorkspaceRoot(fromDir, context.cwd ?? process.cwd());

    /** `{ type, instance }` for an absolute file path, or null when it belongs to no element */
    const classify = (absFile) => {
      const rel = path.relative(root, absFile);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      const posix = toPosix(rel);
      if (include.length > 0 && !include.some((c) => matchPattern(c, posix))) return null;
      for (const e of elements) {
        const hit = matchPattern(e.compiled, posix);
        if (!hit) continue;
        const names = e.capture ?? [];
        const instance = JSON.stringify([e.type, names.map((n, i) => [n, hit.captures[i] ?? ''])]);
        return { type: e.type, instance };
      }
      return null;
    };

    const self = classify(path.resolve(filename));
    if (!self) return {};

    const check = (sourceNode) => {
      if (!sourceNode || sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string')
        return;
      const spec = sourceNode.value;
      const target = spec.startsWith('.')
        ? resolveRelative(fromDir, spec)
        : resolveBare(fromDir, spec);
      if (!target) return;
      const to = classify(target);
      if (!to || to.instance === self.instance) return;
      if (allowed.get(self.type)?.has(to.type)) return;
      context.report({
        node: sourceNode,
        messageId: 'noPolicy',
        data: { from: self.type, to: to.type },
      });
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression: (node) => {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1
        ) {
          check(node.arguments[0]);
        }
      },
    };
  },
};
