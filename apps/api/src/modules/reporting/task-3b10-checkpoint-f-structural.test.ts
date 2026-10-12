import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 3b.10 Checkpoint F — structural pins of the PUBLIC HTTP WIRING of the five frozen reports.
 *
 * They pin the owner-approved surface: EXACTLY nine read-only GET routes, the OD-1 permission map (all three Sales
 * permissions), the company-wide-needs-unrestricted-branch-authority rule, thin controllers over the frozen services, strict
 * query reading, the single module registration and the additive guard features — and that nothing frozen (the 25 A–E
 * production hashes, the permission registry, the role templates, the schema, the migrations) moved. Every pin is
 * sensitivity-tested (a deliberate violation must turn it red).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');
const ROOT = resolve(SRC, '../../..');
const read = (abs: string): string => readFileSync(abs, 'utf8');
const sha = (abs: string): string =>
  createHash('sha256').update(read(abs).replace(/\r\n/g, '\n')).digest('hex');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = (name: string): string => stripComments(read(join(HERE, name)));

const CONTROLLERS = [
  'trial-balance.controller.ts',
  'sales-financial-report.controller.ts',
  'tender-totals-report.controller.ts',
  'receivables-report.controller.ts',
  'customer-liabilities-report.controller.ts',
];
const F_PRODUCTION = [...CONTROLLERS, 'reporting.module.ts', 'reporting-query.ts'].sort();

/** the approved route table: file → [{ verb path, primary permission, extra permissions, all-branches, branch route }] */
const ROUTES: Record<
  string,
  { path: string; perm: string; extra: string[]; wide: boolean; branch: boolean }[]
> = {
  'trial-balance.controller.ts': [
    {
      path: 'reports/trial-balance',
      perm: 'accounting:view',
      extra: [],
      wide: true,
      branch: false,
    },
  ],
  'sales-financial-report.controller.ts': [
    {
      path: 'reports/sales',
      perm: 'orders:view',
      extra: ['credit_notes:view', 'receivables:view'],
      wide: true,
      branch: false,
    },
    {
      path: 'branches/:branchId/reports/sales',
      perm: 'orders:view',
      extra: ['credit_notes:view', 'receivables:view'],
      wide: false,
      branch: true,
    },
  ],
  'tender-totals-report.controller.ts': [
    { path: 'reports/tender-totals', perm: 'payments:view', extra: [], wide: true, branch: false },
    {
      path: 'branches/:branchId/reports/tender-totals',
      perm: 'payments:view',
      extra: [],
      wide: false,
      branch: true,
    },
  ],
  'receivables-report.controller.ts': [
    { path: 'reports/receivables', perm: 'receivables:view', extra: [], wide: true, branch: false },
    {
      path: 'branches/:branchId/reports/receivables',
      perm: 'receivables:view',
      extra: [],
      wide: false,
      branch: true,
    },
  ],
  'customer-liabilities-report.controller.ts': [
    {
      path: 'reports/customer-liabilities',
      perm: 'receivables:view',
      extra: [],
      wide: true,
      branch: false,
    },
    {
      path: 'branches/:branchId/reports/customer-liabilities',
      perm: 'receivables:view',
      extra: [],
      wide: false,
      branch: true,
    },
  ],
};

/** split a controller into its route methods (the text from each `@Get(` to the next one or the class end) */
function methodsOf(name: string): string[] {
  const c = code(name);
  const parts = c.split(/\n\s*@Get\(/).slice(1);
  return parts.map((p) => '@Get(' + p);
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the frozen Checkpoints A–E are byte-identical (25 production hashes) and nothing shared moved', () => {
  const FROZEN_A_D: Record<string, string> = {
    'report-date-range.ts': 'b2a3859b05638788a75f3d51a9c084a14f5588fc0606799ecae0cf7f87fbd8aa',
    'report-money.ts': '3a125d7f9926a84c5961657fdc007466d6dce41216863eaa034978cca8367bb1',
    'reporting.repository.ts': '012207a0e26e085b08f95e45c7ed3315ea81a8653ac25d9bdff9ba152d279a3c',
    'trial-balance.ts': 'bf82c8c1bd4bd56bc9b5294c257414540eba69f9e3d7544143e4fb4d02c43d3a',
    'trial-balance.sql.ts': 'cf4c267c40881f3e63481ef039abd5f7435877845e49fc38e7eeba04b03e6821',
    'trial-balance.repository.ts':
      '40e1b01900e2a6911411a86e5ef570b9848118e566f43af5b4614e4581061c7b',
    'trial-balance.service.ts': '6fd6cc46c24cdf86b3c07bfdd67923cc15c35f6471accba10274f8473dc2075d',
    'sales-financial-report.ts': '724ded058d15b40d93c5382d980b2db6b4837ceb456217a62a57029f422c8422',
    'sales-financial-report.sql.ts':
      'de4618891eab1d7c34a48bd873164730226b087f6694221611d99f9cf77e9528',
    'sales-financial-report.repository.ts':
      'd26efb618d8c1cd16b80abbf6e10bf9c90a197f3a724318fdad852df04c7520e',
    'sales-financial-report.service.ts':
      '33d2c722b7ff855edb59462edaad8033ac56d1c8fb56475bcb193167f2a89bc5',
    'sales-invoice-line-set-proof.ts':
      'f8301ec53c69a8c8eb244864c50295a93b67c584f83fb53706ef9b2c84dae635',
    'sales-report-range.ts': 'dd66505d1050eb9b77a656bed50cef421561dcb99a251d91adc63d97e3fa6f63',
    'tender-totals-report.ts': 'f417a47b1180bfb9d0d2753a7cfc9a307d38989cdd24baaad47b886d54a0e3a2',
    'tender-totals-report.sql.ts':
      'c6c5fe43bad3817580f2a375d8845792e72a5870ea3c96e31b9da44ee855d374',
    'tender-totals-report.repository.ts':
      '4b5c3a4faf84920d57962e93ff287c8d61c06a54c3398cd372ebca5fe3fc22fb',
    'tender-totals-report.service.ts':
      'b582883f7489db78bd29e26ab09ccda9a2dc5086b296e009902a665178be95fe',
    'receivables-report.ts': '924599ad8bea2a4773cd2803088c7ffa99ccddd93cd18d7755efca36869021cd',
    'receivables-report.sql.ts': 'fd60ac46536edf3c8404c7b4956d6b0e28ffb48943337c6bdf2381f5c8bc5d32',
    'receivables-report.repository.ts':
      '704183552f5c53927bff2d4545344ddf710a627b6a29d53e3c15b5e5c3f933be',
    'receivables-report.service.ts':
      '9c8ffb69c3b4cca1de017ec0c7ae15dae024c693dcbdb78707a62d2b9f1111b8',
  };
  const FROZEN_E: Record<string, string> = {
    'customer-liabilities-report.ts':
      'df7fe5829ae86ed0fc621f24d3ade77da30e7a371b15f0e022a45b6e95706361',
    'customer-liabilities-report.sql.ts':
      'f11bf273ad7b74727835c6691a8cdcd05cfcbdb5c762a4b7b241c3d70fac57ab',
    'customer-liabilities-report.repository.ts':
      '19ee7bda4b78ba54270cd8112dc4f51bdf83d7b3a997e972f5236edd3d59efa3',
    'customer-liabilities-report.service.ts':
      '94a1632547e2f585ebd816b56323933891583936d0a8d8b0e57ae96efed552ee',
  };
  for (const [file, hash] of [...Object.entries(FROZEN_A_D), ...Object.entries(FROZEN_E)]) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(HERE, file))).toBe(hash);
    });
  }

  it('no migration 50, no schema change, no permission-registry change, no role-template change', () => {
    const dirs = readdirSync(join(ROOT, 'packages/db/prisma/migrations')).filter(
      (n) => !n.endsWith('.toml'),
    );
    expect(dirs).toHaveLength(49);
    expect(dirs.sort()[dirs.length - 1]).toBe(
      '20261010120000_phase_3b8_currency_and_release_integrity',
    );
    expect(sha(join(ROOT, 'packages/db/prisma/schema.prisma'))).toBe(
      '15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459',
    );
    expect(sha(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
    expect(sha(join(SRC, 'modules/platform/system-roles.ts'))).toBe(
      '977d2e6bd6e215b70d034ce6b6def9e3ff97eb282555541c271ce278028d14f0',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — EXACTLY nine read-only routes, each with the approved permission and scope rule', () => {
  it('the F production surface is exactly five controllers, the module and the query helper', () => {
    const names = readdirSync(HERE).filter(
      (n) => /\.(controller|module)\.ts$|^reporting-query\.ts$/.test(n) && !/\.test\.ts$/.test(n),
    );
    expect(names.sort()).toEqual(F_PRODUCTION);
  });

  it('nine @Get routes and nothing else: no write verb, no @Public, no @Body, no step-up opt-out, no raw guard wiring', () => {
    let gets = 0;
    for (const name of CONTROLLERS) {
      const c = code(name);
      gets += (c.match(/@Get\(/g) ?? []).length;
      expect(c, name).not.toMatch(/@Post\b|@Put\b|@Patch\b|@Delete\b|@All\b|@Options\b|@Head\b/);
      expect(c, name).not.toMatch(
        /@Public\b|@NoStepUp\b|@Body\b|@Headers\b|@Req\b|@Request\b|@UseGuards\b|@SetMetadata\b|@Res\b/,
      );
      expect((c.match(/@Controller\(/g) ?? []).length, name).toBe(1);
      expect(c, name).toContain("@Controller('companies/:companyId')");
    }
    expect(gets).toBe(9);
  });

  it('each route is exactly the approved one: path, OD-1 primary permission, the extra Sales permissions, scope rule', () => {
    for (const name of CONTROLLERS) {
      const expected = ROUTES[name]!;
      const methods = methodsOf(name);
      expect(methods, name).toHaveLength(expected.length);
      expected.forEach((r, i) => {
        const m = methods[i]!;
        expect(m, `${name} ${r.path}`).toMatch(
          new RegExp(`^@Get\\('${r.path.replace(/[/:]/g, (x) => '\\' + x)}'\\)`),
        );
        expect(m, name).toContain(`@RequirePermission('${r.perm}')`);
        if (r.extra.length > 0) {
          expect(m, name).toContain(
            `@RequireAllPermissions(${r.extra.map((k) => `'${k}'`).join(', ')})`,
          );
        } else {
          expect(m, name).not.toContain('@RequireAllPermissions');
        }
        expect(m.includes('@RequireAllBranches()'), `${name} ${r.path} all-branches`).toBe(r.wide);
        if (r.branch) {
          expect(m, name).toContain("@ScopedParam({ company: 'companyId', branch: 'branchId' })");
        } else {
          expect(m, name).toContain("@ScopedParam({ company: 'companyId' })");
        }
        // the permission is the ONLY authorization input: exactly one primary key per route
        expect((m.match(/@RequirePermission\(/g) ?? []).length).toBe(1);
      });
    }
  });

  it('the OD-1 permission map is exactly: accounting:view · orders+credit_notes+receivables · payments:view · receivables:view ×2', () => {
    const used = new Set<string>();
    for (const name of CONTROLLERS) {
      const c = code(name);
      for (const m of c.matchAll(/'([a-z_]+:[a-z_]+(?::[a-z_]+)?)'/g)) used.add(m[1]!);
    }
    expect([...used].sort()).toEqual([
      'accounting:view',
      'credit_notes:view',
      'orders:view',
      'payments:view',
      'receivables:view',
    ]);
    // every key is already in the frozen registry — F registers none
    const registry = read(join(ROOT, 'packages/permissions/src/index.ts'));
    for (const k of used) expect(registry, k).toContain(`'${k}'`);
  });

  it('every company-wide route (and only those) demands unrestricted branch authority; every branch route is branch-scoped', () => {
    for (const name of CONTROLLERS) {
      for (const [i, m] of methodsOf(name).entries()) {
        const r = ROUTES[name]![i]!;
        expect(m.includes('@RequireAllBranches()')).toBe(!r.branch);
        expect(m.includes("branch: 'branchId'")).toBe(r.branch);
        expect(m).toContain("company: 'companyId'");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — thin controllers: no business logic, no data access, strict query, frozen services only', () => {
  const SERVICE_OF: Record<string, string> = {
    'trial-balance.controller.ts': 'TrialBalanceService',
    'sales-financial-report.controller.ts': 'SalesFinancialReportService',
    'tender-totals-report.controller.ts': 'TenderTotalsReportService',
    'receivables-report.controller.ts': 'ReceivablesReportService',
    'customer-liabilities-report.controller.ts': 'CustomerLiabilitiesReportService',
  };

  it('each controller injects ONLY its frozen service and each route returns that service’s result untouched', () => {
    for (const name of CONTROLLERS) {
      const c = code(name);
      expect(c, name).toContain(`constructor(private readonly service: ${SERVICE_OF[name]})`);
      expect((c.match(/constructor\(/g) ?? []).length).toBe(1);
      const returns = [...c.matchAll(/return this\.service\.(\w+)\(/g)].map((m) => m[1]);
      expect(returns, name).toHaveLength(ROUTES[name]!.length);
      // no await, no transform, no catch: a route is one return statement
      expect(c, name).not.toMatch(
        /\bawait\b|\.then\(|\btry\b|\bcatch\b|\.map\(|\.filter\(|\bnew Date\b/,
      );
    }
  });

  it('controllers import no repository, no Prisma, no SQL, no money, no database layer', () => {
    for (const name of CONTROLLERS) {
      const c = code(name);
      expect(c, name).not.toMatch(
        /repository|Repository|@flower\/db|\$queryRaw|runScoped|DbService|ScopedRepository|Money|BigInt|bigint|Number\(|parseInt|parseFloat|Math\./,
      );
      for (const m of c.matchAll(/from '([^']+)'/g)) {
        expect(
          [
            '@nestjs/common',
            '../../common/auth/index.js',
            '../../common/auth/pipeline.decorators.js',
          ].includes(m[1]!) ||
            /^\.\/(trial-balance|sales-financial-report|tender-totals-report|receivables-report|customer-liabilities-report)\.service\.js$/.test(
              m[1]!,
            ) ||
            m[1] === './reporting-query.js',
          `${name} imports ${m[1]}`,
        ).toBe(true);
      }
    }
  });

  it('the scope comes ONLY from the validated route params: companyId / branchId are @Param, never read from the query or a body', () => {
    for (const name of CONTROLLERS) {
      const c = code(name);
      expect(c, name).toMatch(/@Param\('companyId'\) companyId: string/);
      expect(c, name).not.toMatch(
        /query\.(?:companyId|branchId|tenantId)|query\[\s*['"](?:companyId|branchId|tenantId)/,
      );
      const branchRoutes = ROUTES[name]!.filter((r) => r.branch).length;
      expect((c.match(/@Param\('branchId'\) branchId: string/g) ?? []).length, name).toBe(
        branchRoutes,
      );
      expect((c.match(/@Query\(\) query: Record<string, unknown>/g) ?? []).length, name).toBe(
        ROUTES[name]!.length,
      );
    }
  });

  it('the strict query reader accepts exactly the documented keys and rejects every other with 400 VALIDATION_FAILED', () => {
    const q = code('reporting-query.ts');
    expect(q).toContain("strictQuery(raw, ['from', 'to'])");
    expect(q).toContain("strictQuery(raw, ['customerId', 'cursor', 'limit'])");
    expect((q.match(/strictQuery\(raw, \[/g) ?? []).length).toBe(2);
    expect(q).toMatch(/'VALIDATION_FAILED', 'unsupported query parameter', 400/);
    // the period controllers read only the period, the paged ones only the page — and each uses the matching reader
    for (const name of ['trial-balance', 'sales-financial-report', 'tender-totals-report']) {
      const c = code(`${name}.controller.ts`);
      expect(c).toContain('periodQuery(query)');
      expect(c).not.toContain('pageQuery');
    }
    for (const name of ['receivables-report', 'customer-liabilities-report']) {
      const c = code(`${name}.controller.ts`);
      expect(c).toContain('pageQuery(query)');
      expect(c).not.toContain('periodQuery');
    }
    // a repeated customerId is never a customer id; limit is converted only from a plain digit string
    expect(q).toMatch(
      /typeof customerId !== 'string'\)\s*throw new DomainError\('NOT_FOUND', 'customer not found', 404\)/,
    );
    expect(q).toMatch(/\^\[0-9\]\{1,15\}\$/);
    // no validation of dates / limits / cursors is re-implemented here: that stays in the frozen services
    expect(q).not.toMatch(/INVALID_DATE|INVALID_LIMIT|INVALID_CURSOR|UUID|uuid/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — module wiring: one module, registered once, read-only, no new provider kind', () => {
  it('the reporting module declares the five controllers and the ten frozen providers — and nothing else', () => {
    const m = code('reporting.module.ts');
    expect((m.match(/Controller,?\s*$/gm) ?? []).length).toBeGreaterThanOrEqual(5);
    for (const c of [
      'TrialBalanceController',
      'SalesFinancialReportController',
      'TenderTotalsReportController',
      'ReceivablesReportController',
      'CustomerLiabilitiesReportController',
    ]) {
      expect(m, c).toContain(c);
    }
    for (const p of [
      'TrialBalance',
      'SalesFinancialReport',
      'TenderTotalsReport',
      'ReceivablesReport',
      'CustomerLiabilitiesReport',
    ]) {
      expect(m, p).toContain(`${p}Repository,`);
      expect(m, p).toContain(`${p}Service,`);
    }
    expect(m).not.toMatch(
      /imports:|exports:|APP_GUARD|APP_INTERCEPTOR|APP_FILTER|useClass|useFactory|useValue/,
    );
  });

  it('app.module registers ReportingModule exactly once, and registers no other reporting artifact', () => {
    const app = code('../../app.module.ts');
    expect((app.match(/ReportingModule/g) ?? []).length).toBe(2); // the import and the list entry
    expect(app).toContain(
      "import { ReportingModule } from './modules/reporting/reporting.module.js';",
    );
    expect(app).not.toMatch(
      /Controller|TrialBalance|SalesFinancial|TenderTotals|ReceivablesReport|CustomerLiabilities/,
    );
  });

  it('the wiring is read-only: no audit, outbox, idempotency, write or step-up vocabulary in any F production file', () => {
    for (const name of F_PRODUCTION) {
      expect(code(name), name).not.toMatch(
        /AuditWriter|OutboxWriter|Idempotency|idempotency|\$executeRaw|INSERT |UPDATE |DELETE |@Throttle|rate[-_ ]?limit|setTimeout|Cache|cache-control/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the additive guard features live in the ONE centralized pipeline', () => {
  const guard = (): string => stripComments(read(join(SRC, 'common/auth/permission.guard.ts')));
  const deco = (): string =>
    stripComments(read(join(SRC, 'common/auth/require-permission.decorator.ts')));
  const engine = (): string => stripComments(read(join(SRC, 'modules/access/policy-engine.ts')));

  it('@RequireAllPermissions and @RequireAllBranches are metadata decorators; @RequirePermission is unchanged', () => {
    const d = deco();
    expect(d).toMatch(
      /export const RequireAllPermissions = \(\s*\.\.\.permissions: PermissionKey\[\],?\s*\): MethodDecorator & ClassDecorator => SetMetadata\(REQUIRED_ALL_PERMISSIONS_KEY, permissions\);/,
    );
    expect(d).toMatch(
      /export const RequireAllBranches = \(\): MethodDecorator & ClassDecorator =>\s*SetMetadata\(REQUIRES_ALL_BRANCHES_KEY, true\);/,
    );
    expect(d).toMatch(
      /export const RequirePermission = \(\s*permission: PermissionKey \| PlatformPermissionKey,\s*\): MethodDecorator & ClassDecorator => SetMetadata\(REQUIRED_PERMISSION_KEY, permission\);/,
    );
  });

  it('the guard decides EVERY key with the same engine, the first denial wins, and a company-wide target carries allBranches from METADATA only', () => {
    const g = guard();
    expect(g).toContain('const allRequired = [required, ...extra.filter((k) => k !== required)];');
    expect(g).toMatch(
      /let decision = this\.engine\.can\(ctx, required, target, \{ stepUpExempt \}\);/,
    );
    expect(g).toMatch(/for \(const key of allRequired\) \{\s*if \(!decision\.allowed\) break;/);
    expect(g).toMatch(/decision = this\.engine\.can\(ctx, key, target, \{ stepUpExempt \}\);/);
    expect(g).toMatch(/REQUIRES_ALL_BRANCHES_KEY\) === true/);
    // the allBranches flag is never read from the request (params / query / body / headers)
    expect(g).not.toMatch(/allBranches\s*[:=]\s*(?:req|source|ctx)\b/);
    // a denied branch/company scope is still the non-disclosing 404; the guard order is unchanged
    expect(g).toMatch(
      /case 'COMPANY_OUT_OF_SCOPE':\s*case 'BRANCH_OUT_OF_SCOPE':[\s\S]*?throw new NotFoundError\('resource'\)/,
    );
    // impersonation stays an allowlist over ALL required keys
    expect(g).toMatch(/allRequired\.some\(\(k\) => !IMPERSONATION_READ_ALLOWLIST\.has\(k\)\)/);
  });

  it('the engine denies a company-wide target unless branchScope is "ALL" and no overlay withholds the key — before the branch step', () => {
    const e = engine();
    expect(e).toMatch(
      /if \(target\.allBranches === true\) \{\s*if \(ctx\.branchScope !== 'ALL'\) \{\s*return deny\('BRANCH_OUT_OF_SCOPE'/,
    );
    expect(e).toMatch(
      /for \(const keys of ctx\.perBranchOverlay\.values\(\)\) \{\s*if \(!keys\.has\(permissionKey\)\) \{\s*return deny\('BRANCH_OUT_OF_SCOPE'/,
    );
    expect(e.indexOf('target.allBranches === true')).toBeLessThan(
      e.indexOf('if (target.branchId != null)'),
    );
    expect(e.indexOf('inScope(ctx.companyScope')).toBeLessThan(
      e.indexOf('target.allBranches === true'),
    );
  });

  it('the new decorators are exported once and used by the report controllers only', () => {
    const idx = read(join(SRC, 'common/auth/index.ts'));
    expect(idx).toContain('RequireAllPermissions');
    expect(idx).toContain('RequireAllBranches');
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, n.name);
        if (n.isDirectory()) {
          if (n.name !== 'node_modules' && n.name !== 'dist') walk(p);
        } else if (
          p.endsWith('.ts') &&
          !/\.test\.ts$/.test(p) &&
          /@RequireAllPermissions\(|@RequireAllBranches\(/.test(stripComments(read(p)))
        ) {
          users.push(p.slice(SRC.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(SRC);
    expect(users.sort()).toEqual(CONTROLLERS.map((n) => `modules/reporting/${n}`).sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — the suites pin their own contracts', () => {
  it('the controller integration test covers the nine routes, the role matrix, the three Sales permissions, branch isolation and the validation errors', () => {
    const t = read(join(HERE, 'reporting.controller.integration.test.ts'));
    for (const title of [
      'EXACTLY nine report routes are registered',
      'role matrix: every default role against every route',
      'Sales needs ALL THREE permissions',
      'BRANCH-RESTRICTED user (one branch)',
      'MULTI-branch user',
      'per-branch overlay withholds the permission',
      'cross-tenant',
      'invalid and nonexistent identifiers are a plain 404',
      'executed NO report query',
      'an unsupported query parameter is 400 VALIDATION_FAILED',
      'limit and cursor',
      'customer filter',
      'no write happened',
      'REPORT_COMPANY_NOT_CONFIGURED',
    ]) {
      expect(t, title).toContain(title);
    }
    expect(t).toMatch(/vi\.spyOn\(\s*ReportingRepository\.prototype/);
  });

  it('the guard-level suites exist: the pipeline e2e for the new decorators and the engine truth table', () => {
    const e2e = read(join(SRC, 'common/auth/multi-permission.e2e.test.ts'));
    for (const t of [
      '@RequirePermission alone is unchanged',
      'missing ANY one key',
      '@RequireAllBranches is enforced even without a @ScopedParam',
    ]) {
      expect(e2e, t).toContain(t);
    }
    expect(read(join(SRC, 'modules/access/policy-engine.test.ts'))).toContain(
      'company-wide targets (allBranches)',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('F — FROZEN, OWNER APPROVED (2026-10-10): the thirteen production files are byte-locked and the freeze is recorded', () => {
  /** every production file Checkpoint F created or modified (paths under apps/api/src) — the complete inventory */
  const FROZEN_F: Record<string, string> = {
    'modules/reporting/trial-balance.controller.ts':
      '4516652b8317a3f01d6722008c4126ac8194b1bcb1839bd3d3cbd1ed0b7bd268',
    'modules/reporting/sales-financial-report.controller.ts':
      'f17ae5018be259a75f1718d3e8740e7785330cced129878d53d5306d4317485f',
    'modules/reporting/tender-totals-report.controller.ts':
      'a615e50660bfaf7f557f1a0b0998fce5e6086b6e2db6dbe5fdbf59ee5f16abdb',
    'modules/reporting/receivables-report.controller.ts':
      'c9c3559d5cf8a2378c79dcbe73ac5952e6fac61b705cd0cace900834b8f9d297',
    'modules/reporting/customer-liabilities-report.controller.ts':
      'fa449b63c83b841423defcd8e28d0180c5378246d249c4654ccd76a51369c7cb',
    'modules/reporting/reporting.module.ts':
      '101923cdf62915a60038db557fb9172e025d4b33eac65b3f7e3a64ad8cfc085a',
    'modules/reporting/reporting-query.ts':
      'acad3a4c04681884777912176952f4795c94022c3cd8b78d501e4d42a5f1dfc4',
    'common/auth/require-permission.decorator.ts':
      '6e1c61d7a2f6265d5e8f28b57e6f4c8eaf52a284a65c864b2ba97058e0b1c3f5',
    'common/auth/permission.guard.ts':
      '4ac82090bba97ff704d5c0832d7a852b0ff648d691657c1319995bd506444bad',
    'modules/access/policy-engine.ts':
      '7e09ff11223da0464797ce610026da3f3e15de1621b69eb33157ae0e9f5391ad',
    'modules/access/policy.types.ts':
      'e1b7e8150964977a4ee7411102a327e784321bfba048fb1364efb04c769000e3',
    'common/auth/index.ts': '82c72320c5bbd285b865ee11a921a85465528d5ca29dcfbc2c9a58dbd04fa98b',
    'app.module.ts': '41b71356bbb2863144ea387d271a8612c2b339ecce3ceda0e71c5c90e371c1f3',
  };
  const PLAN = (): string => read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
  const LOG = (): string => read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
  const freezeSection = (): string => {
    const at = PLAN().indexOf('### Freeze — Checkpoint F: FROZEN — OWNER APPROVED (2026-10-10)');
    expect(at).toBeGreaterThan(0);
    return PLAN().slice(at);
  };

  for (const [file, hash] of Object.entries(FROZEN_F)) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(SRC, file))).toBe(hash);
    });
  }

  it('the lock inventory is the complete F surface: five controllers, module, query helper, and the six shared authorization files', () => {
    expect(Object.keys(FROZEN_F)).toHaveLength(13);
    const reporting = Object.keys(FROZEN_F).filter((f) => f.startsWith('modules/reporting/'));
    expect(reporting.map((f) => f.slice('modules/reporting/'.length)).sort()).toEqual(
      [...CONTROLLERS, 'reporting-query.ts', 'reporting.module.ts'].sort(),
    );
    // every F production file in the reporting directory is locked (a new unlocked controller / module / helper fails)
    const locked = new Set(reporting.map((f) => f.slice('modules/reporting/'.length)));
    for (const n of readdirSync(HERE).filter(
      (x) => /\.(controller|module)\.ts$|^reporting-query\.ts$/.test(x) && !/\.test\.ts$/.test(x),
    )) {
      expect(locked.has(n), n).toBe(true);
    }
  });

  it('exactly nine GET routes remain across the locked controllers, each with the frozen permission', () => {
    const table: string[] = [];
    for (const c of CONTROLLERS) {
      const src = code(c);
      for (const m of src.matchAll(/@Get\('([^']+)'\)\s*@RequirePermission\('([^']+)'\)/g)) {
        table.push(`${m[1]} ${m[2]}`);
      }
      expect((src.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length, c).toBe(
        c === 'trial-balance.controller.ts' ? 1 : 2,
      );
    }
    expect(table.sort()).toEqual(
      [
        'reports/trial-balance accounting:view',
        'reports/sales orders:view',
        'branches/:branchId/reports/sales orders:view',
        'reports/tender-totals payments:view',
        'branches/:branchId/reports/tender-totals payments:view',
        'reports/receivables receivables:view',
        'branches/:branchId/reports/receivables receivables:view',
        'reports/customer-liabilities receivables:view',
        'branches/:branchId/reports/customer-liabilities receivables:view',
      ].sort(),
    );
  });

  it('the Task 3b.9 historical protections are preserved: the pre-F guard and policy-engine hashes and the reconstruction proof remain', () => {
    const e = read(join(SRC, 'modules/sales/task-3b9-checkpoint-e-structural.test.ts'));
    for (const h of [
      '55eef3431078efc1c6837960cbd1034d4928a5b06ab815cdc67e9d69052c80b8',
      'c9f9da28608233496bcccb40e558f2b77883810e81dff0a1c11fe5abb241a8d7',
      FROZEN_F['common/auth/permission.guard.ts'] as string,
      FROZEN_F['modules/access/policy-engine.ts'] as string,
    ]) {
      expect(e, h).toContain(h);
    }
    expect(e).toContain(
      'minus the approved additive F blocks is byte-identical to the frozen pre-F file',
    );
    expect(e).toContain('every approved additive F block is present exactly once');
  });

  it('no F production file or pin disables a lint rule or lowers a threshold', () => {
    for (const f of [...Object.keys(FROZEN_F).map((x) => join(SRC, x))]) {
      expect(read(f), f).not.toMatch(/eslint-disable|eslint-enable|@ts-ignore|@ts-nocheck/);
    }
  });

  it('the scoped lint waiver is exact: the historical settlement script is untouched and carries exactly the five recorded console statements', () => {
    const script = join(SRC, 'scripts/reconcile-historical-settlements.ts');
    expect(sha(script)).toBe('ab1ca3ee42e93b9a32c843bd6868331e353c534c6c431cc3aa23a55b19213068');
    const consoleLines = read(script)
      .split('\n')
      .map((l, i) => (/\bconsole\./.test(l) ? i + 1 : 0))
      .filter((n) => n > 0);
    expect(consoleLines).toEqual([110, 111, 124, 127, 135]);
  });

  it('the plan records Checkpoint F as FROZEN — OWNER APPROVED with G and Task 3b.11 NOT STARTED', () => {
    const rows = (letter: string): string[] =>
      PLAN()
        .split('\n')
        .filter((l) => new RegExp(`^\\| ${letter}\\s+\\|`).test(l));
    expect(rows('F')[0]).toMatch(/FROZEN — OWNER APPROVED \(2026-10-10\)/);
    expect(rows('F')[0]).not.toMatch(/NOT frozen|awaiting owner/);
    expect(rows('G')[0]).toMatch(/local verification run [(]2026-10-10[)].*NOT frozen/);
    const f = freezeSection();
    expect(f).toMatch(/Checkpoint G \(final hard gates\) and Task 3b\.11 are NOT STARTED/);
    expect(f).toMatch(
      /Checkpoints A–E stay frozen with their twenty-five pinned production hashes/,
    );
    for (const hash of Object.values(FROZEN_F)) {
      expect(f).toContain(`${hash.slice(0, 8)}…${hash.slice(-4)}`);
    }
    for (const needle of [
      'exactly nine read-only `GET` routes',
      '`@RequireAllPermissions`',
      '`@RequireAllBranches`',
      'non-disclosing 404',
      'cross-tenant',
    ]) {
      expect(f.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  it('the plan records the scoped ESLint waiver exactly: file, rule, the five lines, history, approval and the remediation duty', () => {
    const f = freezeSection();
    expect(f).toContain('`apps/api/src/scripts/reconcile-historical-settlements.ts`');
    expect(f).toContain('`no-console`');
    expect(f).toContain('**110, 111, 124, 127 and 135**');
    expect(f).toContain('d5d4d06');
    expect(f).toContain('2026-09-28');
    expect(f).toContain('owner-approved 2026-10-10');
    expect(f).toMatch(/not a passing whole-source zero-warning gate/);
    expect(f).toMatch(/does not disable a rule, does not raise any warning threshold/);
    expect(f).toMatch(/Future remediation \(required\)/);
  });

  it('the decision log appends exactly one 3b.10-FF freeze row and keeps the committed rows (3b.10-PW, 3b.10-FZ)', () => {
    const rows = LOG()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-FF**'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/FROZEN, OWNER APPROVED \(2026-10-10\)/);
    expect(rows[0]).toMatch(/thirteen production files/);
    expect(rows[0]).toMatch(/lines 110, 111, 124, 127, 135/);
    expect(rows[0]).toMatch(/Checkpoint G \(final gates\) and Task 3b\.11 are \*\*NOT STARTED\*\*/);
    expect(
      LOG()
        .split('\n')
        .filter((l) => l.startsWith('| **3b.10-PW**')),
    ).toHaveLength(1);
    expect(
      LOG()
        .split('\n')
        .filter((l) => l.startsWith('| **3b.10-FZ**')),
    ).toHaveLength(1);
  });
});
