import { describe, expect, it } from 'vitest';
import { GET, POST } from '../api/[[...route]].ts';

/** The Vercel entry point serves the same relay as `npm run relay:dev`. */
describe('Vercel entry point', () => {
  it('answers the health check', async () => {
    const response = await GET(new Request('https://app.example/api/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('routes model requests to the relay', async () => {
    const response = await POST(
      new Request('https://app.example/api/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      }),
    );
    // Without a key the relay refuses before reading the body.
    expect(response.status).toBe(503);
  });
});
