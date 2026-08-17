/** HTTP layer tests, focused on the routing cases the dataset makes dangerous. */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import { store } from '../src/data/store.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  const json = await Bun.file(
    new URL('../data/model_prices_and_context_window.json', import.meta.url),
  ).text();
  store.loadFromString(json);

  // Ephemeral port: the tests must not clash with anything already running.
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

/** Response bodies are typed loosely: tests care about the assertion, not about modelling. */
interface TestResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous bodies in test assertions
  json(): Promise<any>;
}

const get = (path: string): Promise<TestResponse> =>
  fetch(new URL(path, base).toString()) as Promise<TestResponse>;

const post = (path: string, body: unknown): Promise<TestResponse> =>
  fetch(new URL(path, base).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<TestResponse>;

describe('health and meta', () => {
  test('/health reports 3038 models', async () => {
    const body = await (await get('/health')).json();
    expect(body.status).toBe('ok');
    expect(body.models).toBe(3038);
  });

  test('/v1/meta exposes the source and the counts', async () => {
    const body = await (await get('/v1/meta')).json();
    expect(body.models).toBe(3038);
    expect(body.providers).toBe(123);
    expect(body.dataset.source).toContain('litellm_internal_staging');
  });
});

describe('lookup by id — the critical case', () => {
  test('resolves an id with a slash and a colon', async () => {
    const id = 'bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0';
    const res = await get(`/v1/models/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.litellm_provider).toBe('bedrock');
  });

  test('resolves a 4-segment id', async () => {
    const res = await get('/v1/models/1024-x-1024/50-steps/bedrock/amazon.nova-canvas-v1:0');
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('1024-x-1024/50-steps/bedrock/amazon.nova-canvas-v1:0');
  });

  test('resolves an id containing a literal `*`', async () => {
    const res = await get('/v1/models/bedrock/*/1-month-commitment/cohere.command-text-v14');
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('bedrock/*/1-month-commitment/cohere.command-text-v14');
  });

  test('resolves an id with no slashes', async () => {
    expect((await (await get('/v1/models/claude-sonnet-4-5')).json()).id).toBe('claude-sonnet-4-5');
  });

  test('the id ending in a slash is reachable through /models/by-id', async () => {
    const id = 'fireworks_ai/accounts/fireworks/models/';
    const res = await get(`/v1/models/by-id?id=${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(id);
  });

  test('/models/by-id is not swallowed by the wildcard', async () => {
    const res = await get('/v1/models/by-id');
    expect(res.status).toBe(400);
    expect((await res.json()).title).toContain('id');
  });

  test('404 with useful suggestions', async () => {
    const res = await get('/v1/models/claude-sonnet-9-9');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.suggestions.length).toBeGreaterThan(0);
  });

  test('409 when the id differs only by case', async () => {
    // The dataset ships together_ai/baai/... and together_ai/BAAI/... as distinct entries.
    const res = await get('/v1/models/together_ai/BaAi/bge-base-en-v1.5');
    expect(res.status).toBe(409);
    expect((await res.json()).candidates).toHaveLength(2);
  });

  test('the exact lookup takes priority over the case-insensitive one', async () => {
    const res = await get('/v1/models/together_ai/BAAI/bge-base-en-v1.5');
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('together_ai/BAAI/bge-base-en-v1.5');
  });
});

describe('listing and filters', () => {
  test('paginates to 50 by default', async () => {
    const body = await (await get('/v1/models')).json();
    expect(body.total).toBe(3038);
    expect(body.data).toHaveLength(50);
  });

  test('filters by provider and mode', async () => {
    const body = await (await get('/v1/models?provider=anthropic&mode=chat&limit=500')).json();
    expect(body.total).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(m.litellm_provider).toBe('anthropic');
      expect(m.mode).toBe('chat');
    }
  });

  test('filters by any supports_* key', async () => {
    const body = await (await get('/v1/models?supports_vision=true&limit=5')).json();
    for (const m of body.data) expect(m.supports_vision).toBe(true);
  });

  test('projects only the requested fields', async () => {
    const body = await (await get('/v1/models?fields=id,mode&limit=3')).json();
    expect(Object.keys(body.data[0]).sort()).toEqual(['id', 'mode']);
  });

  test('sorts and leaves the models without the field last', async () => {
    const body = await (await get('/v1/models?sort=input_cost_per_token:desc&limit=500')).json();
    const costs = body.data.map((m: Record<string, unknown>) => m['input_cost_per_token']);
    const defined = costs.filter((c: unknown) => typeof c === 'number');
    for (let i = 1; i < defined.length; i++) expect(defined[i]).toBeLessThanOrEqual(defined[i - 1]);
  });

  test('rejects an invalid query with 400', async () => {
    expect((await get('/v1/models?limit=abc')).status).toBe(400);
  });
});

describe('facets', () => {
  test('/v1/providers returns 123', async () => {
    const body = await (await get('/v1/providers')).json();
    expect(body.total).toBe(123);
  });

  test('/v1/modes counts the models without a mode', async () => {
    const body = await (await get('/v1/modes')).json();
    expect(body.total).toBe(15);
    expect(body.models_without_mode).toBe(8);
  });

  test('/v1/attributes marks which keys are pricing keys', async () => {
    const body = await (await get('/v1/attributes')).json();
    expect(body.total).toBe(144);
    expect(body.pricing_keys).toBe(81);
  });
});

describe('POST /v1/estimate', () => {
  test('computes a simple case', async () => {
    const res = await post('/v1/estimate', {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.USD.exact).toBe('0.045');
    expect(body.model.resolved_key).toBe('claude-sonnet-4-5');
    expect(body.lines).toHaveLength(2);
  });

  test('every line carries the literal dataset key so it can be audited', async () => {
    const res = await post('/v1/estimate', {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 210_000, output_tokens: 1_000 },
    });
    const body = await res.json();
    expect(body.resolution.rate_keys_used).toContain('input_cost_per_token_above_200k_tokens');
    expect(body.resolution.context_tier_applied).toBe('above_200k_tokens');
  });

  test('422 for a model with no pricing data', async () => {
    const res = await post('/v1/estimate', {
      model: 'github_copilot/gpt-4o',
      usage: { input_tokens: 100 },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).type).toContain('model-not-priced');
  });

  test('404 for a model that does not exist', async () => {
    const res = await post('/v1/estimate', { model: 'no-existe', usage: { input_tokens: 1 } });
    expect(res.status).toBe(404);
  });

  test('400 when reasoning_tokens exceeds output_tokens', async () => {
    const res = await post('/v1/estimate', {
      model: 'claude-sonnet-4-5',
      usage: { output_tokens: 10, reasoning_tokens: 20 },
    });
    expect(res.status).toBe(400);
  });

  test('400 on an unknown usage field', async () => {
    const res = await post('/v1/estimate', {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1, campo_inventado: 5 },
    });
    expect(res.status).toBe(400);
  });

  test('limit_policy=error turns the breach into a 422', async () => {
    const res = await post('/v1/estimate', {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 500_000 },
      options: { limit_policy: 'error' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).type).toContain('limits-exceeded');
  });
});

describe('comparison', () => {
  test('compares several models and reports the missing ones', async () => {
    const res = await get('/v1/compare?ids=claude-sonnet-4-5,gpt-4o,no-existe');
    const body = await res.json();
    expect(body.found).toBe(2);
    expect(body.missing).toEqual(['no-existe']);
    expect(body.attributes).toContain('input_cost_per_token');
  });
});

describe('errors', () => {
  test('404 in problem+json format', async () => {
    const res = await get('/v1/ruta-inexistente');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});
