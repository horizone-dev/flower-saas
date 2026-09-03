import { createApiClient } from '@flower/api-client';
import { Button } from '@flower/ui';

// Phase 0 shell: fetch the API health at request time and render the status.
export const dynamic = 'force-dynamic';

async function getApiStatus(): Promise<'healthy' | 'unavailable'> {
  const baseUrl = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001';
  try {
    const client = createApiClient({ baseUrl });
    const res = await client.health();
    return res.status === 'ok' ? 'healthy' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export default async function Page() {
  const status = await getApiStatus();
  return (
    <main
      style={{
        maxWidth: '40rem',
        margin: '4rem auto',
        padding: '0 1.5rem',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <p style={{ fontSize: '0.85rem', letterSpacing: '0.08em', color: '#9d174d' }}>
        FLOWER SAAS · PHASE 0
      </p>
      <h1 style={{ fontSize: '1.6rem', margin: '0.25rem 0 0.5rem' }}>Super Admin</h1>
      <p style={{ color: '#4b574f', marginTop: 0 }}>Platform control plane</p>
      <p style={{ marginTop: '1.5rem', fontSize: '1.1rem' }}>
        API: <strong>{status === 'healthy' ? 'healthy' : 'unavailable'}</strong>
      </p>
      <div style={{ marginTop: '1rem' }}>
        <Button variant="secondary">Design system shell</Button>
      </div>
    </main>
  );
}
