/** Boot-time dataset resolution: local file as the source of truth, upstream as revalidation. */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { metaPathFor, readLocalDataset, writeLocalDataset } from '../src/data/local.ts';
import { Store } from '../src/data/store.ts';

const FIXTURE = JSON.stringify({
  'gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0.0000025 },
});
const UPSTREAM = JSON.stringify({
  'gpt-4o': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0.0000025 },
  'claude-opus-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 0.000005 },
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let dir: string;
let datasetPath: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'delfos-dataset-'));
  datasetPath = join(dir, 'model_prices_and_context_window.json');
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

/** Records what the last request asked for, so the tests can assert on `If-None-Match`. */
let lastRequestHeaders: Record<string, string> = {};

function mockUpstream(responder: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    lastRequestHeaders = (init?.headers ?? {}) as Record<string, string>;
    return responder();
  }) as typeof fetch;
}

async function seedLocal(json: string, meta?: { etag?: string; sha256?: string }): Promise<void> {
  await writeFile(datasetPath, json, 'utf8');
  if (meta) {
    await writeFile(
      metaPathFor(datasetPath),
      JSON.stringify({ ...meta, fetchedAt: new Date().toISOString() }),
      'utf8',
    );
  }
}

describe('readLocalDataset', () => {
  test('returns null when there is no local file', async () => {
    expect(await readLocalDataset(datasetPath)).toBeNull();
  });

  test('trusts the sidecar ETag when the sha256 matches', async () => {
    await seedLocal(FIXTURE, { etag: '"abc123"', sha256: sha(FIXTURE) });
    const local = await readLocalDataset(datasetPath);
    expect(local?.etag).toBe('"abc123"');
    expect(local?.sha256).toBe(sha(FIXTURE));
  });

  test('discards the ETag when the sidecar is out of sync', async () => {
    await seedLocal(FIXTURE, { etag: '"stale"', sha256: sha('something else entirely') });
    const local = await readLocalDataset(datasetPath);
    expect(local?.json).toBe(FIXTURE);
    expect(local?.etag).toBeUndefined();
  });

  test('serves the file with no ETag when there is no sidecar', async () => {
    await seedLocal(FIXTURE);
    const local = await readLocalDataset(datasetPath);
    expect(local?.json).toBe(FIXTURE);
    expect(local?.etag).toBeUndefined();
  });
});

describe('writeLocalDataset', () => {
  test('writes the JSON and the sidecar, leaving no temp files behind', async () => {
    expect(await writeLocalDataset(UPSTREAM, '"new"', sha(UPSTREAM), datasetPath)).toBe(true);

    expect(await readFile(datasetPath, 'utf8')).toBe(UPSTREAM);
    const meta = JSON.parse(await readFile(metaPathFor(datasetPath), 'utf8'));
    expect(meta.etag).toBe('"new"');
    expect(meta.sha256).toBe(sha(UPSTREAM));
    expect(meta.fetchedAt).toBeString();

    const written = await readLocalDataset(datasetPath);
    expect(written?.etag).toBe('"new"');
  });

  test('is not fatal when the path cannot be written', async () => {
    const unwritable = join('/proc/definitely-not-writable', 'dataset.json');
    expect(await writeLocalDataset(UPSTREAM, '"new"', sha(UPSTREAM), unwritable)).toBe(false);
  });
});

describe('boot resolution', () => {
  /** A throwaway store per case, pointed at the temp dataset. */
  const boot = async (): Promise<Store> => {
    const store = new Store();
    await store.init(datasetPath);
    return store;
  };

  test('a 304 keeps the local copy and transfers nothing', async () => {
    await seedLocal(FIXTURE, { etag: '"current"', sha256: sha(FIXTURE) });
    mockUpstream(() => new Response(null, { status: 304 }));

    const store = await boot();
    expect(lastRequestHeaders['If-None-Match']).toBe('"current"');
    expect(store.snapshot.source).toBe('local');
    expect(store.snapshot.etag).toBe('"current"');
    expect(store.snapshot.models).toHaveLength(1);
    expect(store.lastError).toBeNull();
  });

  test('a 200 replaces the local copy and persists the new ETag', async () => {
    await seedLocal(FIXTURE, { etag: '"old"', sha256: sha(FIXTURE) });
    mockUpstream(() => new Response(UPSTREAM, { status: 200, headers: { etag: '"fresh"' } }));

    const store = await boot();
    expect(store.snapshot.source).toBe('upstream');
    expect(store.snapshot.models).toHaveLength(2);
    expect(await readFile(datasetPath, 'utf8')).toBe(UPSTREAM);

    // The sidecar must now describe what actually sits on disk, or the next boot re-downloads.
    const reread = await readLocalDataset(datasetPath);
    expect(reread?.etag).toBe('"fresh"');
    expect(reread?.json).toBe(UPSTREAM);
  });

  test('an out-of-sync sidecar forces an unconditional download', async () => {
    await seedLocal(FIXTURE, { etag: '"stale"', sha256: sha('mismatch') });
    mockUpstream(() => new Response(UPSTREAM, { status: 200, headers: { etag: '"fresh"' } }));

    const store = await boot();
    expect(lastRequestHeaders['If-None-Match']).toBeUndefined();
    expect(store.snapshot.source).toBe('upstream');
  });

  test('a missing sidecar forces an unconditional download', async () => {
    await seedLocal(FIXTURE);
    mockUpstream(() => new Response(UPSTREAM, { status: 200, headers: { etag: '"fresh"' } }));

    const store = await boot();
    expect(lastRequestHeaders['If-None-Match']).toBeUndefined();
    expect(store.snapshot.source).toBe('upstream');
  });

  test('an unreachable upstream falls back to the local copy and records the error', async () => {
    await seedLocal(FIXTURE, { etag: '"current"', sha256: sha(FIXTURE) });
    mockUpstream(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const store = await boot();
    expect(store.snapshot.source).toBe('local');
    expect(store.snapshot.models).toHaveLength(1);
    expect(store.lastError).toContain('ECONNREFUSED');
  });

  test('an upstream 500 also falls back to the local copy', async () => {
    await seedLocal(FIXTURE, { etag: '"current"', sha256: sha(FIXTURE) });
    mockUpstream(() => new Response('boom', { status: 500, statusText: 'Server Error' }));

    const store = await boot();
    expect(store.snapshot.source).toBe('local');
    expect(store.lastError).toContain('500');
  });

  test('a 304 with no local copy is not treated as data', async () => {
    mockUpstream(() => new Response(null, { status: 304 }));
    expect(boot()).rejects.toThrow('Could not load the initial dataset');
  });

  test('no local copy and a failing upstream is fatal', async () => {
    mockUpstream(() => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(boot()).rejects.toThrow('Could not load the initial dataset');
  });

  test('a corrupt local file surfaces a clear error when upstream is down', async () => {
    await seedLocal('{ not json at all');
    mockUpstream(() => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(boot()).rejects.toThrow('the local dataset is unusable');
  });
});
