import { describe, expect, it, vi } from 'vitest';
import devMockHandler from '../api/dev/mock-payment/[reference]';
import webhookHandler from '../api/webhooks/[provider]';

function responseCapture() {
  const result: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) { result.status = code; return response; },
    json(body: unknown) { result.body = body; },
    end() { return undefined; },
  };
  return { result, response };
}

describe('production demo guards', () => {
  it('blocks the mock payment endpoint when Vercel marks the deployment production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', 'production');
    const { result, response } = responseCapture();

    await devMockHandler({ method: 'POST', headers: {}, query: { reference: 'CAT-20260902-ABC234' } }, response);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'Not found' });
    vi.unstubAllEnvs();
  });

  it('does not accept the mock webhook on production deployments', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', 'production');
    const { result, response } = responseCapture();

    await webhookHandler({ method: 'POST', headers: {}, body: '{}', query: { provider: 'mock' } }, response);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ ok: false, error: 'Not found' });
    vi.unstubAllEnvs();
  });

  it('blocks the simulator on hosted preview deployments too', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', 'preview');
    const { result, response } = responseCapture();

    await devMockHandler({ method: 'POST', headers: {}, query: { reference: 'CAT-20260902-ABC234' } }, response);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'Not found' });
    vi.unstubAllEnvs();
  });
});
