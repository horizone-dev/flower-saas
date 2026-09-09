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

    // resolution — company-scoped GET, optional ?at=, NO branchId in the path/query
    await client.resolveVariantTax('c1', 'v1');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/tax',
    );
    expect(fetchMock.mock.calls[2]![1]!.method ?? 'GET').toBe('GET');

    await client.resolveVariantTax('c1', 'v1', '2020-07-01T00:00:00.000Z');
    expect(String(fetchMock.mock.calls[3]![0])).toBe(
      'http://api.test/v1/catalog/companies/c1/variants/v1/tax?at=2020-07-01T00%3A00%3A00.000Z',
    );
    expect(String(fetchMock.mock.calls[3]![0])).not.toMatch(/branchId|posTerminal/i);

    // no tax-amount / compute helper on the client
    expect((client as unknown as Record<string, unknown>)['computeVariantTax']).toBeUndefined();
  });
});
