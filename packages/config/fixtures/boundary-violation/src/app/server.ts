// An "app" element. Allowed to import "pure".
export function bootstrap(): string {
  return 'ok';
}

// DELIBERATE VIOLATION: reads a scope value from the request body.
// `flower/no-scope-from-request` must flag this.
export function handler(req: { body: { tenantId: string } }): string {
  const tenantId = req.body.tenantId;
  return tenantId;
}
