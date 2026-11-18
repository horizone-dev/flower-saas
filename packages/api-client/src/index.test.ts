import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError } from './index.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('@flower/api-client', () => {
  it('calls /healthz with the bearer token and parses the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'http://api.test/',
      fetch: fetchMock,
      getAccessToken: () => 'tok-123',
    });

    const res = await client.health();
    expect(res).toEqual({ status: 'ok' });
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://api.test/healthz');
    expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer tok-123' });
  });

  it('throws a typed ApiError from the error envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { code: 'NOT_READY', message: 'db down', correlationId: '01J' } },
        { status: 503 },
      ),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
    });

    await expect(client.readiness()).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'NOT_READY',
      correlationId: '01J',
    });
  });

  it('requires a fetch implementation', () => {
    expect(() =>
      createApiClient({ baseUrl: 'x', fetch: undefined as unknown as typeof fetch }),
    ).not.toThrow(); // falls back to globalThis.fetch which exists on Node 24
    expect(ApiError).toBeTypeOf('function');
  });

  it('builds a query string for the audit viewer and drops undefined params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [], nextBefore: null }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.queryAudit({ tenantId: 't1', action: 'role', limit: 25 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/platform/audit?tenantId=t1&action=role&limit=25',
    );
  });

  it('applies the credentials mode and default headers to every request (browser cookie flow)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      credentials: 'include',
      headers: { 'x-auth-transport': 'cookie' },
    });

    await client.refresh(); // no arg -> cookie transport, empty body
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/v1/auth/refresh');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({
      'x-auth-transport': 'cookie',
      accept: 'application/json',
    });
    // the refresh token is never in the body on the cookie flow
    expect(JSON.parse(String(init?.body ?? '{}'))).not.toHaveProperty('refreshToken');
  });

  it('omits credentials entirely when not configured (server-side clients)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.refresh('rt-abc');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.credentials).toBeUndefined();
    expect(JSON.parse(String(init.body)).refreshToken).toBe('rt-abc');
  });

  it('sends a JSON body + Idempotency-Key on provisioning', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ tenantId: 'x' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });
    await client.provisionTenant(
      {
        slug: 'acme',
        name: 'Acme',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: 'pv1',
        ownerEmail: 'a@b.co',
      },
      'idem-1',
    );
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      'idempotency-key': 'idem-1',
    });
    expect(JSON.parse(String(init.body)).slug).toBe('acme');
  });

  it('catalog: createProduct sends Idempotency-Key; updateProduct sends If-Match; activate sends both (task 3.2)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 'p1', version: 2, fulfilmentStrategy: 'STOCKED' }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    await client.createProduct(
      { categoryId: 'c1', nameEn: 'Rose', fulfilmentStrategy: 'STOCKED' },
      'idem-prod-1',
    );
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      'idempotency-key': 'idem-prod-1',
    });
    expect(fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty('if-match');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://api.test/v1/catalog/products');

    await client.updateProduct('p1', { nameEn: 'Red Rose' }, 3);
    const upd = fetchMock.mock.calls[1]![1]!;
    expect(upd.method).toBe('PUT');
    expect(upd.headers).toMatchObject({ 'if-match': '"3"' });
    expect(upd.headers).not.toHaveProperty('idempotency-key');

    await client.activateProduct('p1', 3, 'idem-act-1');
    const act = fetchMock.mock.calls[2]![1]!;
    expect(act.method).toBe('POST');
    expect(act.headers).toMatchObject({ 'if-match': '"3"', 'idempotency-key': 'idem-act-1' });
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/activate',
    );
  });

  it('catalog: listProducts builds a query string and drops undefined params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [], nextCursor: null, hasNextPage: false }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.listProducts({ status: 'ACTIVE', q: 'rose', limit: 20 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/products?status=ACTIVE&q=rose&limit=20',
    );
  });

  it('catalog: attribute definition + product-attributes methods carry the right preconditions (task 3.3)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'ad1', version: 2 }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    await client.createAttributeDefinition(
      { key: 'COLOUR', nameEn: 'Colour', valueType: 'ENUM' },
      'idem-ad-1',
    );
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'idem-ad-1' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/attribute-definitions',
    );

    await client.setAttributeOptions('ad1', [{ value: 'RED', labelEn: 'Red' }], 3);
    const opt = fetchMock.mock.calls[1]![1]!;
    expect(opt.method).toBe('PUT');
    expect(opt.headers).toMatchObject({ 'if-match': '"3"' });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'http://api.test/v1/catalog/attribute-definitions/ad1/options',
    );

    await client.setProductAttributes('p1', [{ attributeDefinitionId: 'ad1', valueText: 'x' }], 5);
    const pa = fetchMock.mock.calls[2]![1]!;
    expect(pa.method).toBe('PUT');
    expect(pa.headers).toMatchObject({ 'if-match': '"5"' });
    expect(pa.headers).not.toHaveProperty('idempotency-key');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/attributes',
    );
  });

  it('catalog: option-group + variant methods carry the right preconditions (task 3.4)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'x', version: 2 }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    await client.createOptionGroup('p1', { key: 'COLOUR', nameEn: 'Colour' }, 'idem-og-1');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'idem-og-1' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/option-groups',
    );

    await client.setOptionValues('p1', 'g1', [{ value: 'RED', labelEn: 'Red' }], 4);
    const ov = fetchMock.mock.calls[1]![1]!;
    expect(ov.method).toBe('PUT');
    expect(ov.headers).toMatchObject({ 'if-match': '"4"' });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/option-groups/g1/values',
    );

    await client.createVariant(
      'p1',
      { optionValues: [{ optionGroupId: 'g1', optionValueId: 'v1' }] },
      'idem-var-1',
    );
    expect(fetchMock.mock.calls[2]![1]!.headers).toMatchObject({ 'idempotency-key': 'idem-var-1' });
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/variants',
    );

    await client.activateVariant('var1', 7, 'idem-var-act');
    const act = fetchMock.mock.calls[3]![1]!;
    expect(act.method).toBe('POST');
    expect(act.headers).toMatchObject({ 'if-match': '"7"', 'idempotency-key': 'idem-var-act' });
    expect(String(fetchMock.mock.calls[3]![0])).toBe(
      'http://api.test/v1/catalog/variants/var1/activate',
    );
  });

  it('catalog: identifier methods carry the right preconditions (task 3.5)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'i1', status: 'ACTIVE' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    // create — Idempotency-Key, no If-Match
    await client.createIdentifier(
      { targetKind: 'VARIANT', targetId: 'var1', codeType: 'SKU', value: 'rose-red' },
      'idem-id-1',
    );
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'idem-id-1' });
    expect(fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty('if-match');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://api.test/v1/catalog/identifiers');

    // scan-resolve — bare value query
    await client.resolveIdentifier('5901234123457');
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'http://api.test/v1/catalog/identifiers?value=5901234123457',
    );

    // list-by-target — targetKind + targetId query
    await client.listVariantIdentifiers('var1');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/identifiers?targetKind=VARIANT&targetId=var1',
    );

    // delete — plain, no If-Match / Idempotency-Key
    await client.deleteIdentifier('i1');
    const del = fetchMock.mock.calls[3]![1]!;
    expect(del.method).toBe('DELETE');
    expect(del.headers).not.toHaveProperty('if-match');
    expect(String(fetchMock.mock.calls[3]![0])).toBe('http://api.test/v1/catalog/identifiers/i1');

    // reactivate — Idempotency-Key
    await client.reactivateIdentifier('i1', 'idem-react-1');
    expect(fetchMock.mock.calls[4]![1]!.method).toBe('POST');
    expect(fetchMock.mock.calls[4]![1]!.headers).toMatchObject({
      'idempotency-key': 'idem-react-1',
    });
    expect(String(fetchMock.mock.calls[4]![0])).toBe(
      'http://api.test/v1/catalog/identifiers/i1/reactivate',
    );
  });

  it('catalog: UOM + conversion methods carry the right preconditions (task 3.6)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ code: 'box', version: 3, rows: [] }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    // create UOM — Idempotency-Key, no If-Match
    await client.createUom({ code: 'box', family: 'EACH', nameEn: 'Box' }, 'idem-uom-1');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'idem-uom-1' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://api.test/v1/catalog/uoms');

    // update UOM — If-Match, no Idempotency-Key
    await client.updateUom('box', { nameEn: 'Big Box' }, 3);
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ 'if-match': '"3"' });
    expect(fetchMock.mock.calls[1]![1]!.headers).not.toHaveProperty('idempotency-key');

    // delete UOM — If-Match
    await client.deleteUom('box', 3);
    expect(fetchMock.mock.calls[2]![1]!.method).toBe('DELETE');
    expect(fetchMock.mock.calls[2]![1]!.headers).toMatchObject({ 'if-match': '"3"' });

    // set variant base UOM — parent If-Match
    await client.setVariantBaseUom('var1', 'piece', 7);
    expect(fetchMock.mock.calls[3]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[3]![1]!.headers).toMatchObject({ 'if-match': '"7"' });
    expect(String(fetchMock.mock.calls[3]![0])).toBe(
      'http://api.test/v1/catalog/variants/var1/base-uom',
    );

    // replace variant conversions — parent If-Match, no Idempotency-Key
    await client.replaceVariantConversions('var1', [{ fromUomCode: 'box', num: '12' }], 7);
    expect(fetchMock.mock.calls[4]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[4]![1]!.headers).toMatchObject({ 'if-match': '"7"' });
    expect(fetchMock.mock.calls[4]![1]!.headers).not.toHaveProperty('idempotency-key');
    expect(String(fetchMock.mock.calls[4]![0])).toBe(
      'http://api.test/v1/catalog/variants/var1/conversions',
    );

    // product conversions GET + PUT
    await client.getProductConversions('p1');
    expect(String(fetchMock.mock.calls[5]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/conversions',
    );
    await client.replaceProductConversions(
      'p1',
      [{ fromUomCode: 'box', toUomCode: 'piece', num: '12' }],
      4,
    );
    expect(fetchMock.mock.calls[6]![1]!.headers).toMatchObject({ 'if-match': '"4"' });

    // identifier create with pack metadata still carries Idempotency-Key
    await client.createIdentifier(
      {
        targetKind: 'VARIANT',
        targetId: 'var1',
        codeType: 'BARCODE',
        value: 'BC-1',
        pack: { uomCode: 'box', qty: '1' },
      },
      'idem-pack-1',
    );
    expect(fetchMock.mock.calls[7]![1]!.headers).toMatchObject({
      'idempotency-key': 'idem-pack-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[7]![1]!.body))).toMatchObject({
      pack: { uomCode: 'box', qty: '1' },
    });
  });

  it('catalog: company pricing methods carry the right preconditions (task 3.7)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ version: 1, priceSetExists: true, prices: [] }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    // GET prices — no If-Match, no Idempotency-Key
    await client.getCompanyPrices('c1', 'v1');
    expect(fetchMock.mock.calls[0]![1]!.method ?? 'GET').toBe('GET');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/prices',
    );

    // replace prices — dedicated price-set version as If-Match, NO Idempotency-Key, NO purchase
    await client.replaceCompanyPrices(
      'c1',
      'v1',
      [{ uomCode: 'box', sell: { amountMinor: '5500', currency: 'AED', exponent: 2 } }],
      3,
    );
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ 'if-match': '"3"' });
    expect(fetchMock.mock.calls[1]![1]!.headers).not.toHaveProperty('idempotency-key');
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(body).toEqual({
      prices: [{ uomCode: 'box', sell: { amountMinor: '5500', currency: 'AED', exponent: 2 } }],
    });
    expect(JSON.stringify(body)).not.toMatch(/purchase/i);
    expect(JSON.stringify(body)).not.toMatch(/branch/i);

    // resolve — query carries ONLY uomCode (no branchId — task 3.8)
    await client.resolveCompanyPrice('c1', 'v1', 'box');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/prices/resolve?uomCode=box',
    );
    expect(String(fetchMock.mock.calls[2]![0])).not.toMatch(/branchId/i);
  });

  it('catalog: branch pricing + availability methods carry the right preconditions (task 3.8)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ version: 1, priceSetExists: true, prices: [], entries: [] }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    // GET branch prices — no If-Match, no Idempotency-Key; no companyId in the path
    await client.getBranchPrices('b1', 'v1');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/branches/b1/variants/v1/prices',
    );

    // replace branch prices — dedicated branch price-set version as If-Match, NO
    // Idempotency-Key, NO purchase, NO branchId in the body
    await client.replaceBranchPrices(
      'b1',
      'v1',
      [{ uomCode: 'box', sell: { amountMinor: '5000', currency: 'AED', exponent: 2 } }],
      2,
    );
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ 'if-match': '"2"' });
    expect(fetchMock.mock.calls[1]![1]!.headers).not.toHaveProperty('idempotency-key');
    const priceBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(JSON.stringify(priceBody)).not.toMatch(/purchase/i);
    expect(JSON.stringify(priceBody)).not.toMatch(/"branchId"/);

    // resolve — query carries ONLY uomCode
    await client.resolveBranchPrice('b1', 'v1', 'box');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/branches/b1/variants/v1/prices/resolve?uomCode=box',
    );

    // availability — Idempotency-Key, NO If-Match; entries sorted ascending
    await client.setBranchAvailability(
      'b1',
      [
        { variantId: 'v-b', available: false },
        { variantId: 'v-a', available: true },
      ],
      'ik-avail-1',
    );
    expect(fetchMock.mock.calls[3]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[3]![1]!.headers).toMatchObject({ 'idempotency-key': 'ik-avail-1' });
    expect(fetchMock.mock.calls[3]![1]!.headers).not.toHaveProperty('if-match');
    const availBody = JSON.parse(String(fetchMock.mock.calls[3]![1]!.body));
    expect(availBody.entries.map((e: { variantId: string }) => e.variantId)).toEqual([
      'v-a',
      'v-b',
    ]); // sorted ascending for canonical transport

    // NO deleteBranchPrices method exists (PUT [] is the only clear op — BD-4)
    expect((client as unknown as Record<string, unknown>)['deleteBranchPrices']).toBeUndefined();
  });

  it('catalog: setBranchAvailability NEVER silently dedupes — a duplicate variantId throws before any HTTP call (task 3.8, Correction C)', () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ entries: [] }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });
    expect(() =>
      client.setBranchAvailability(
        'b1',
        [
          { variantId: 'dup', available: true },
          { variantId: 'dup', available: false },
        ],
        'ik-dup',
      ),
    ).toThrow(/duplicate variantId/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('catalog: tax-category assignment + resolution methods carry the right preconditions (task 3.9)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ taxCategoryKey: 'STANDARD', version: 4 }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    // product assignment — PUT, If-Match: "<version>", no Idempotency-Key, tenant path
    await client.setProductTaxCategory('p1', 'STANDARD', 3);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/catalog/products/p1/tax-category',
    );
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('PUT');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'if-match': '"3"' });
    expect(fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty('idempotency-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      taxCategoryKey: 'STANDARD',
    });

    // variant assignment — clearing with an explicit null
    await client.setVariantTaxCategory('v1', null, 2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      'http://api.test/v1/catalog/variants/v1/tax-category',
    );
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ 'if-match': '"2"' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ taxCategoryKey: null });

    // resolution — company-scoped GET, REQUIRED ?date=YYYY-MM-DD, NO branchId
    await client.resolveVariantTax('c1', 'v1', '2026-07-01');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/tax?date=2026-07-01',
    );
    expect(fetchMock.mock.calls[2]![1]!.method ?? 'GET').toBe('GET');

    await client.resolveVariantTax('c1', 'v1', '2020-07-01');
    expect(String(fetchMock.mock.calls[3]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/tax?date=2020-07-01',
    );
    expect(String(fetchMock.mock.calls[3]![0])).not.toMatch(/branchId|posTerminal|[?&]at=/i);

    // no tax-amount / compute helper on the client
    expect((client as unknown as Record<string, unknown>)['computeVariantTax']).toBeUndefined();
  });

  it('applyBusinessTypeTemplate sends BOTH Idempotency-Key and If-Match, default mode merge (task 3.10)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ tenantId: 't1', aggregateVersion: 4 }),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });

    await client.applyBusinessTypeTemplate('t1', 'BAKERY_CAKE', 3, 'idem-key-abcd1234');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/v1/platform/tenants/t1/apply-business-type-template');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({
      'if-match': '"3"',
      'idempotency-key': 'idem-key-abcd1234',
    });
    expect(JSON.parse(String(init!.body))).toEqual({ templateKey: 'BAKERY_CAKE', mode: 'merge' });

    await client.applyBusinessTypeTemplate(
      't1',
      'PERFUME_ATTAR',
      4,
      'idem-key-efgh5678',
      'replace',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      templateKey: 'PERFUME_ATTAR',
      mode: 'replace',
    });
  });
});

describe('@flower/api-client — default fetch (browser regression)', () => {
  it('calls the global fetch bound to globalThis (an unbound browser fetch throws "Illegal invocation")', async () => {
    const strictFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    });
    vi.stubGlobal('fetch', strictFetch);
    try {
      const client = createApiClient({ baseUrl: 'http://api.test' });
      await expect(client.health()).resolves.toEqual({ status: 'ok' });
      expect(strictFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('@flower/api-client — POS selling routes (request contract)', () => {
  const C = 'c0000000-0000-4000-8000-000000000001';
  const B = 'b0000000-0000-4000-8000-000000000002';
  const O = 'a0000000-0000-4000-8000-000000000003';
  const make = (body: unknown = {}) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });
    const last = () => {
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      return {
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
    };
    return { client, last };
  };

  it('createOrder: POST with the caller’s Idempotency-Key and ONLY ids / unit / quantity per line', async () => {
    const { client, last } = make({ order: {}, lines: [] });
    await client.createOrder(
      C,
      B,
      { lines: [{ productId: 'p', variantId: 'v', selectedUomCode: 'piece', quantity: '2' }] },
      'key-1',
    );
    expect(last()).toMatchObject({
      url: `http://api.test/v1/companies/${C}/branches/${B}/orders`,
      method: 'POST',
      headers: { 'idempotency-key': 'key-1', authorization: 'Bearer tok' },
      body: {
        lines: [{ productId: 'p', variantId: 'v', selectedUomCode: 'piece', quantity: '2' }],
      },
    });
  });

  it('updateOrder: PATCH with the order version as If-Match', async () => {
    const { client, last } = make({ order: {}, lines: [] });
    await client.updateOrder(C, B, O, { customerId: null }, 3);
    expect(last()).toMatchObject({
      url: `http://api.test/v1/companies/${C}/branches/${B}/orders/${O}`,
      method: 'PATCH',
      headers: { 'if-match': '"3"' },
      body: { customerId: null },
    });
  });

  it('completeSale: POST complete-sale with If-Match AND Idempotency-Key and the tenders — no totals, no price', async () => {
    const { client, last } = make({});
    await client.completeSale(
      C,
      B,
      O,
      { paymentIntent: 'PAY_NOW', tenders: [{ method: 'CASH', amountMinor: '2888' }] },
      4,
      'key-2',
    );
    expect(last()).toMatchObject({
      url: `http://api.test/v1/companies/${C}/branches/${B}/orders/${O}/complete-sale`,
      method: 'POST',
      headers: { 'if-match': '"4"', 'idempotency-key': 'key-2' },
      body: { paymentIntent: 'PAY_NOW', tenders: [{ method: 'CASH', amountMinor: '2888' }] },
    });
  });

  it('reads: totals, order, invoice, orders list (status + cursor), customers search, customer create', async () => {
    const { client, last } = make({ data: [], nextCursor: null });
    await client.getOrderTotals(C, B, O);
    expect(last().url).toBe(`http://api.test/v1/companies/${C}/branches/${B}/orders/${O}/totals`);
    await client.getReceiptIdentity(C, B);
    expect(last().url).toBe(`http://api.test/v1/companies/${C}/branches/${B}/receipt-identity`);
    await client.getSalesReport(C, { from: '2026-11-01', to: '2026-11-14' });
    expect(last().url).toBe(
      `http://api.test/v1/companies/${C}/reports/sales?from=2026-11-01&to=2026-11-14`,
    );
    await client.getSalesReport(C, { from: '2026-11-01', to: '2026-11-14', branchId: B });
    expect(last().url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/reports/sales?from=2026-11-01&to=2026-11-14`,
    );
    await client.getOrder(C, B, O);
    expect(last().url).toBe(`http://api.test/v1/companies/${C}/branches/${B}/orders/${O}`);
    await client.getInvoice(C, B, 'inv');
    expect(last().url).toBe(`http://api.test/v1/companies/${C}/branches/${B}/invoices/inv`);
    await client.listOrders(C, B, { status: 'CONFIRMED', cursor: 'cur' });
    expect(last().url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/orders?status=CONFIRMED&cursor=cur`,
    );
    await client.listCustomers(C, { displayName: 'Ann' });
    expect(last().url).toBe(`http://api.test/v1/companies/${C}/customers?displayName=Ann`);
    await client.createCustomer(C, { displayName: 'Ann', phone: '+971500000000' }, 'key-3');
    expect(last()).toMatchObject({
      url: `http://api.test/v1/companies/${C}/customers`,
      method: 'POST',
      headers: { 'idempotency-key': 'key-3' },
      body: { displayName: 'Ann', phone: '+971500000000' },
    });
    await client.getBranchEffectiveCatalog(B, { cursor: 'x' });
    expect(last().url).toBe(`http://api.test/v1/catalog/branches/${B}/catalog?cursor=x`);
  });

  it('authenticator enrolment: POST mfa/enrol with an empty body, then mfa/confirm with ONLY the code (existing approved routes)', async () => {
    const { client, last } = make({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
    const e = await client.enrolMfa();
    expect(last()).toMatchObject({
      url: 'http://api.test/v1/auth/mfa/enrol',
      method: 'POST',
      body: {},
    });
    expect(e).toEqual({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
    await client.confirmMfa('123456');
    expect(last()).toMatchObject({
      url: 'http://api.test/v1/auth/mfa/confirm',
      method: 'POST',
      body: { code: '123456' },
    });
  });
});

describe('@flower/api-client — POS customer credit and advance sale (frozen complete-sale contract)', () => {
  const C = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const CUST = '33333333-3333-4333-8333-333333333333';
  const ADV = '44444444-4444-4444-8444-444444444444';
  function recorder(body: unknown = {}) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
      [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse(body);
    });
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 't',
    });
    return { client, calls };
  }

  it('completeSale carries ON_CREDIT, the advance applications and a credit exception REASON, with If-Match and Idempotency-Key — and nothing authoritative', async () => {
    const { client, calls } = recorder({ paymentIntent: 'ON_CREDIT' });
    await client.completeSale(
      C,
      B,
      'ord-1',
      {
        paymentIntent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: '1000' }],
        advanceApplications: [{ advanceId: ADV, amountMinor: '2500' }],
        creditLimitExceptionReason: 'regular wedding customer',
      },
      7,
      'idem-1',
    );
    const c = calls[0]!;
    expect(c.url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/orders/ord-1/complete-sale`,
    );
    expect(c.method).toBe('POST');
    expect(c.headers['if-match']).toBe('"7"');
    expect(c.headers['idempotency-key']).toBe('idem-1');
    expect(c.body).toEqual({
      paymentIntent: 'ON_CREDIT',
      tenders: [{ method: 'CASH', amountMinor: '1000' }],
      advanceApplications: [{ advanceId: ADV, amountMinor: '2500' }],
      creditLimitExceptionReason: 'regular wedding customer',
    });
    // the server rejects (strict DTO) any scope / customer / money-authority field, so the typed request has none
    expect(Object.keys(c.body as object).sort()).toEqual([
      'advanceApplications',
      'creditLimitExceptionReason',
      'paymentIntent',
      'tenders',
    ]);
  });

  it('getCustomerAccountSummary reads the branch-scoped account summary (receivables:view)', async () => {
    const { client, calls } = recorder({ branchFinancials: {}, credit: {} });
    await client.getCustomerAccountSummary(C, B, CUST);
    expect(calls[0]!.url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/customers/${CUST}/account/summary`,
    );
    expect(calls[0]!.method).toBe('GET');
  });

  it('listCustomerAdvances reads the advances page and forwards cursor / limit only when given', async () => {
    const { client, calls } = recorder({ data: [], nextCursor: null });
    await client.listCustomerAdvances(C, B, CUST);
    await client.listCustomerAdvances(C, B, CUST, { cursor: 'abc', limit: 50 });
    expect(calls[0]!.url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/customers/${CUST}/account/advances`,
    );
    expect(calls[1]!.url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/customers/${CUST}/account/advances?cursor=abc&limit=50`,
    );
  });
});

describe('@flower/api-client — POS customer account and collection (existing receivables + receipt routes)', () => {
  const C = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const CUST = '33333333-3333-4333-8333-333333333333';
  const base = `http://api.test/v1/companies/${C}/branches/${B}/customers/${CUST}`;
  function recorder(body: unknown = {}) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
      [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse(body);
    });
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 't',
    });
    return { client, calls };
  }

  it('reads one customer from the company-scoped route', async () => {
    const { client, calls } = recorder({ id: CUST, displayName: 'Dora' });
    await client.getCustomer(C, CUST);
    expect(calls[0]!.url).toBe(`http://api.test/v1/companies/${C}/customers/${CUST}`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('lists the OPEN receivables of one customer at one branch, forwarding cursor / limit only when given', async () => {
    const { client, calls } = recorder({ data: [], nextCursor: null });
    await client.listCustomerReceivables(C, B, CUST);
    await client.listCustomerReceivables(C, B, CUST, { cursor: 'c1', limit: 25 });
    expect(calls[0]!.url).toBe(`${base}/account/receivables`);
    expect(calls[1]!.url).toBe(`${base}/account/receivables?cursor=c1&limit=25`);
  });

  it('reads the statement with an optional date range and cursor, and the unapplied receipts', async () => {
    const { client, calls } = recorder({ data: [], nextCursor: null, openingState: null });
    await client.getCustomerStatement(C, B, CUST);
    await client.getCustomerStatement(C, B, CUST, {
      from: '2026-11-01',
      to: '2026-11-30',
      limit: 50,
    });
    await client.listCustomerUnappliedReceipts(C, B, CUST, { limit: 10 });
    expect(calls[0]!.url).toBe(`${base}/account/statement`);
    expect(calls[1]!.url).toBe(`${base}/account/statement?from=2026-11-01&to=2026-11-30&limit=50`);
    expect(calls[2]!.url).toBe(`${base}/account/unapplied-receipts?limit=10`);
  });

  it('collectCustomerReceipt POSTs ONLY the amount and method, with the Idempotency-Key — no customer, scope, invoice list or allocation', async () => {
    const { client, calls } = recorder({ paymentId: 'p1' });
    await client.collectCustomerReceipt(
      C,
      B,
      CUST,
      { amountMinor: '1000', method: 'CASH' },
      'idem-collect-1',
    );
    const c = calls[0]!;
    expect(c.url).toBe(`${base}/receipts`);
    expect(c.method).toBe('POST');
    expect(c.headers['idempotency-key']).toBe('idem-collect-1');
    expect(c.body).toEqual({ amountMinor: '1000', method: 'CASH' });
    expect(Object.keys(c.body as object).sort()).toEqual(['amountMinor', 'method']);
  });
});

describe('@flower/api-client — Owner Web customer credit settings and receivables report (existing routes)', () => {
  const C = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const CUST = '33333333-3333-4333-8333-333333333333';
  function recorder(body: unknown = {}) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
      [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse(body);
    });
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 't',
    });
    return { client, calls };
  }

  it('reads the customer credit configuration (and its version) from the company-scoped account route', async () => {
    const { client, calls } = recorder({ creditEnabled: true, version: 4 });
    await client.getCustomerCreditAccount(C, CUST);
    expect(calls[0]!.url).toBe(`http://api.test/v1/companies/${C}/customers/${CUST}/account`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('configureCustomerCredit PATCHes ONLY creditEnabled (+ the limit when given) with If-Match and NO Idempotency-Key', async () => {
    const { client, calls } = recorder({ creditEnabled: true, version: 5 });
    await client.configureCustomerCredit(
      C,
      CUST,
      { creditEnabled: true, creditLimitMinor: '250000' },
      4,
    );
    await client.configureCustomerCredit(C, CUST, { creditEnabled: false }, 5);
    const first = calls[0]!;
    expect(first.url).toBe(`http://api.test/v1/companies/${C}/customers/${CUST}/account/credit`);
    expect(first.method).toBe('PATCH');
    expect(first.headers['if-match']).toBe('"4"');
    expect(first.headers).not.toHaveProperty('idempotency-key');
    expect(first.body).toEqual({ creditEnabled: true, creditLimitMinor: '250000' });
    // disabling without a limit sends NO limit field at all (the server keeps the stored one)
    expect(calls[1]!.body).toEqual({ creditEnabled: false });
    expect(Object.keys(calls[1]!.body as object)).toEqual(['creditEnabled']);
  });

  it('configureCustomerCredit refuses a limit that is not a plain digit string before any request is made', () => {
    const { client, calls } = recorder();
    expect(() =>
      client.configureCustomerCredit(
        C,
        CUST,
        { creditEnabled: true, creditLimitMinor: '12.50' },
        1,
      ),
    ).toThrow(/creditLimitMinor/);
    expect(() =>
      client.configureCustomerCredit(C, CUST, { creditEnabled: true, creditLimitMinor: '-5' }, 1),
    ).toThrow(/creditLimitMinor/);
    expect(calls).toHaveLength(0);
  });

  it('reads the company receivables report and the one-branch report, forwarding only the given filters', async () => {
    const { client, calls } = recorder({ customers: { rows: [], nextCursor: null } });
    await client.getReceivablesReport(C);
    await client.getReceivablesReport(C, { customerId: CUST, cursor: 'c1', limit: 25 });
    await client.getReceivablesReport(C, { branchId: B });
    expect(calls[0]!.url).toBe(`http://api.test/v1/companies/${C}/reports/receivables`);
    expect(calls[1]!.url).toBe(
      `http://api.test/v1/companies/${C}/reports/receivables?customerId=${CUST}&cursor=c1&limit=25`,
    );
    expect(calls[2]!.url).toBe(
      `http://api.test/v1/companies/${C}/branches/${B}/reports/receivables`,
    );
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
