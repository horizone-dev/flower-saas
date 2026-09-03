import { describe, it, expect } from 'vitest';
import { flowerConfig, BOUNDARY_ELEMENTS, BOUNDARY_POLICIES } from '../src/eslint/index.js';
import plugin from '../src/eslint/plugin.js';
import prettierConfig from '../src/prettier/index.js';
import tailwindPreset from '../src/tailwind/preset.js';

describe('@flower/config exports', () => {
  it('flowerConfig returns a non-empty flat-config array for every type', () => {
    for (const type of ['node', 'nest', 'next', 'pure', 'lib']) {
      const cfg = flowerConfig({ type, tsconfigRootDir: process.cwd() });
      expect(Array.isArray(cfg)).toBe(true);
      expect(cfg.length).toBeGreaterThan(3);
    }
  });

  it("'nest' type enables the three isolation rules", () => {
    const cfg = flowerConfig({ type: 'nest' });
    const ruleBlocks = cfg.filter((b) => b.rules && b.rules['flower/no-scope-from-request']);
    expect(ruleBlocks.length).toBe(1);
    const r = ruleBlocks[0].rules;
    expect(r['flower/no-scope-from-request']).toBe('error');
    expect(r['flower/no-raw-prisma-in-scoped-modules']).toBe('error');
    expect(r['flower/route-must-declare-permission']).toBe('error');
  });

  it('boundaries model is coherent: every policy references a known element type', () => {
    const known = new Set(BOUNDARY_ELEMENTS.map((e) => e.type));
    for (const p of BOUNDARY_POLICIES) {
      const fromT = p.from.element.type;
      expect(known.has(fromT)).toBe(true);
      const to = p.allow.to.element;
      const toTypes = to.types?.anyOf ?? [to.type];
      for (const t of toTypes) expect(known.has(t)).toBe(true);
    }
  });

  it('the flower plugin exposes exactly the three rules', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual([
      'no-raw-prisma-in-scoped-modules',
      'no-scope-from-request',
      'route-must-declare-permission',
    ]);
  });

  it('prettier + tailwind presets are objects', () => {
    expect(prettierConfig.printWidth).toBe(100);
    expect(tailwindPreset.theme.extend.colors.brand[500]).toMatch(/^#/);
  });
});
