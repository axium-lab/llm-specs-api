/**
 * HTTP layer tests, focused on the routing cases the dataset makes dangerous.
 *
 * The store is loaded with `test/fixtures/dataset.ts`, not with `data/`: the ids with slashes,
 * colons, a literal `*`, a trailing `/` and a case-only collision are all in the fixture, so the
 * cases stay covered no matter what upstream renames tomorrow. Every count below is computed
 * from the fixture, never typed in.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import { store } from '../src/data/store.ts';
import { looksLikePricingKey } from '../src/pricing/catalog.ts';
import {
  BATCH,
  CASE_LOWER,
  CASE_UPPER,
  EMBEDDING,
  FIXTURE_JSON,
  FIXTURE_MODELS,
  IMAGE,
  PROVISIONED,
  TIERED,
  UNPRICED,
} from './fixtures/dataset.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  store.loadFromString(FIXTURE_JSON);

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

// What the fixture says, derived rather than typed: a new fixture entry must not break these.
const MODEL_COUNT = FIXTURE_MODELS.length;
const PROVIDERS = new Set(FIXTURE_MODELS.map(([, m]) => m['provider'] as string));
const MODES = new Set(FIXTURE_MODELS.map(([, m]) => m['mode']).filter((x) => typeof x === 'string'));
const WITHOUT_MODE = FIXTURE_MODELS.filter(([, m]) => typeof m['mode'] !== 'string').length;
const ATTRIBUTES = new Set(FIXTURE_MODELS.flatMap(([, m]) => Object.keys(m)));
const PRICING_ATTRIBUTES = [...ATTRIBUTES].filter(looksLikePricingKey).length;

describe('health and meta', () => {
  test('/health reports the loaded model count', async () => {
    const body = await (await get('/health')).json();
    expect(body.status).toBe('ok');
    expect(body.ready).toBe(true);
    expect(body.models).toBe(MODEL_COUNT);
    expect(body.dataset.source).toBe('local');
  });

  test('/v1/meta exposes the source and the counts', async () => {
    const body = await (await get('/v1/meta')).json();
    expect(body.models).toBe(MODEL_COUNT);
    expect(body.providers).toBe(PROVIDERS.size);
    expect(body.modes).toBe(MODES.size);
    expect(body.attributes).toBe(ATTRIBUTES.size);
    expect(body.dataset.source).toBe('local');
    expect(body.dataset.upstream_url).toContain('/refs/heads/main/');
  });
});

describe('lookup by id — the critical case', () => {
  test('resolves an id with a slash and a colon', async () => {
    const res = await get(`/v1/models/${BATCH}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(BATCH);
    expect(body.provider).toBe('beta');
  });

  test('resolves a 4-segment id', async () => {
    const res = await get(`/v1/models/${IMAGE}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(IMAGE);
  });

  test('resolves an id containing a literal `*`', async () => {
    const res = await get(`/v1/models/${PROVISIONED}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(PROVISIONED);
  });

  test('resolves an id with no slashes', async () => {
    expect((await (await get(`/v1/models/${TIERED}`)).json()).id).toBe(TIERED);
  });

  test('the id ending in a slash is reachable through /models/by-id', async () => {
    const res = await get(`/v1/models/by-id?id=${encodeURIComponent(EMBEDDING)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(EMBEDDING);
  });

  test('/models/by-id is not swallowed by the wildcard', async () => {
    const res = await get('/v1/models/by-id');
    expect(res.status).toBe(400);
    expect((await res.json()).title).toContain('id');
  });

  test('404 with useful suggestions', async () => {
    // A typo on a real id: no common substring, so only trigram similarity can rescue it.
    const res = await get(`/v1/models/${TIERED}-9-9`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.suggestions).toContain(TIERED);
  });

  test('409 when the id differs only by case', async () => {
    // The fixture ships `epsilon/baai/...` and `epsilon/BAAI/...` as distinct entries, as upstream does.
    const mixed = CASE_LOWER.replace('baai', 'BaAi');
    const res = await get(`/v1/models/${mixed}`);
    expect(res.status).toBe(409);
    expect((await res.json()).candidates.sort()).toEqual([CASE_UPPER, CASE_LOWER].sort());
  });

  test('the exact lookup takes priority over the case-insensitive one', async () => {
    const res = await get(`/v1/models/${CASE_UPPER}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(CASE_UPPER);
  });
});

describe('listing and filters', () => {
  test('paginates to the default limit', async () => {
    const body = await (await get('/v1/models')).json();
    expect(body.total).toBe(MODEL_COUNT);
    expect(body.data).toHaveLength(Math.min(50, MODEL_COUNT));
  });

  test('filters by provider and mode', async () => {
    const body = await (await get('/v1/models?provider=beta&mode=chat&limit=500')).json();
    const expected = FIXTURE_MODELS.filter(([, m]) => m['provider'] === 'beta' && m['mode'] === 'chat');
    expect(body.total).toBe(expected.length);
    expect(body.total).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(m.provider).toBe('beta');
      expect(m.mode).toBe('chat');
    }
  });

  test('filters by any supports_* key', async () => {
    const body = await (await get('/v1/models?supports_vision=true&limit=500')).json();
    const expected = FIXTURE_MODELS.filter(([, m]) => m['supports_vision'] === true);
    expect(body.total).toBe(expected.length);
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
    // The ones without the field come after every one that has it.
    const firstUndefined = costs.findIndex((c: unknown) => typeof c !== 'number');
    expect(firstUndefined).toBe(defined.length);
  });

  test('rejects an invalid query with 400', async () => {
    expect((await get('/v1/models?limit=abc')).status).toBe(400);
  });
});

describe('facets', () => {
  test('/v1/providers counts every provider once', async () => {
    const body = await (await get('/v1/providers')).json();
    expect(body.total).toBe(PROVIDERS.size);
    expect(body.data.map((p: { name: string }) => p.name).sort()).toEqual([...PROVIDERS].sort());
    const sum = body.data.reduce((acc: number, p: { models: number }) => acc + p.models, 0);
    expect(sum).toBe(MODEL_COUNT);
  });

  test('/v1/modes counts the models without a mode', async () => {
    const body = await (await get('/v1/modes')).json();
    expect(body.total).toBe(MODES.size);
    expect(body.models_without_mode).toBe(WITHOUT_MODE);
  });

  test('/v1/attributes marks which keys are pricing keys', async () => {
    const body = await (await get('/v1/attributes')).json();
    expect(body.total).toBe(ATTRIBUTES.size);
    expect(body.pricing_keys).toBe(PRICING_ATTRIBUTES);
    for (const attr of body.data) expect(attr.pricing).toBe(looksLikePricingKey(attr.name));
  });
});

describe('POST /v1/estimate', () => {
  test('computes a simple case', async () => {
    const res = await post('/v1/estimate', {
      model: TIERED,
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 10000 * 3e-6 + 1000 * 1.5e-5 = 0.045
    expect(body.totals.USD.exact).toBe('0.045');
    expect(body.model.resolved_key).toBe(TIERED);
    expect(body.lines).toHaveLength(2);
  });

  test('every line carries the literal dataset key so it can be audited', async () => {
    const res = await post('/v1/estimate', {
      model: TIERED,
      usage: { input_tokens: 210_000, output_tokens: 1_000 },
    });
    const body = await res.json();
    expect(body.resolution.rate_keys_used).toContain('input_cost_per_token_above_200k_tokens');
    expect(body.resolution.context_tier_applied).toBe('above_200k_tokens');
  });

  test('422 for a model with no pricing data', async () => {
    const res = await post('/v1/estimate', { model: UNPRICED, usage: { input_tokens: 100 } });
    expect(res.status).toBe(422);
    expect((await res.json()).type).toContain('model-not-priced');
  });

  test('404 for a model that does not exist', async () => {
    const res = await post('/v1/estimate', { model: 'no-existe', usage: { input_tokens: 1 } });
    expect(res.status).toBe(404);
  });

  test('400 when reasoning_tokens exceeds output_tokens', async () => {
    const res = await post('/v1/estimate', {
      model: TIERED,
      usage: { output_tokens: 10, reasoning_tokens: 20 },
    });
    expect(res.status).toBe(400);
  });

  test('400 on an unknown usage field', async () => {
    const res = await post('/v1/estimate', {
      model: TIERED,
      usage: { input_tokens: 1, campo_inventado: 5 },
    });
    expect(res.status).toBe(400);
  });

  test('limit_policy=error turns the breach into a 422', async () => {
    const res = await post('/v1/estimate', {
      model: TIERED,
      usage: { input_tokens: 500_000 },
      options: { limit_policy: 'error' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).type).toContain('limits-exceeded');
  });
});

describe('comparison', () => {
  test('compares several models and reports the missing ones', async () => {
    const res = await get(`/v1/compare?ids=${TIERED},${BATCH},no-existe`);
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

describe('CORS', () => {
  test('a GET carries the wildcard origin', async () => {
    const res = await get('/v1/models?limit=1');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  // The estimate endpoint sends a JSON content-type, so browsers preflight it.
  test('the preflight for POST /v1/estimate is answered', async () => {
    const res = await fetch(new URL('/v1/estimate', base).toString(), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });
});
