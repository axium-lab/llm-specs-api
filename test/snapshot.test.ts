/**
 * The vendored dataset itself: invariants that must hold for ANY version of `data/`.
 *
 * This is the only test file that reads the real file, and on purpose it never names a model,
 * a provider or a count. The dataset is refreshed from upstream every day by
 * `.github/workflows/refresh-dataset.yml`, and these are the checks that gate that commit: a
 * refresh that breaks one of them is a refresh the service could not serve.
 */

import { describe, expect, test } from 'bun:test';
import { buildSnapshot } from '../src/data/store.ts';
import { PARSE_VERSION, parse } from '../src/data/parse.ts';
import { estimate } from '../src/pricing/estimate.ts';
import type { EstimateInput } from '../src/pricing/estimate.ts';
import { NON_MODEL_KEYS, isModelEntry } from '../src/types.ts';

const json = await Bun.file(new URL('../data/model_prices_and_context_window.json', import.meta.url)).text();
const raw = JSON.parse(json) as Record<string, unknown>;
const snapshot = buildSnapshot(json);

describe('the vendored dataset', () => {
  test('is already normalized: parse leaves it exactly as it is', () => {
    // What the daily refresh commits is `parse` of upstream; a hand edit that breaks that
    // round trip would make every boot rewrite the file.
    expect(parse(json)).toBe(json);
    expect(PARSE_VERSION).toBeGreaterThan(0);
  });

  test('holds a sizeable number of models, every one with a provider', () => {
    expect(snapshot.models.length).toBeGreaterThan(1000);
    for (const model of snapshot.models) {
      expect(typeof model.provider).toBe('string');
      expect(model.provider).not.toBe('');
    }
  });

  test('keeps the non-model entries out of the catalog', () => {
    const ids = new Set(snapshot.models.map((m) => m.id));
    for (const key of NON_MODEL_KEYS) expect(ids.has(key)).toBe(false);
    // Every object entry that is not on the exclusion list and carries a provider is a model.
    const expected = Object.entries(raw).filter(([k, v]) => isModelEntry(k, v)).length;
    expect(snapshot.models.length).toBe(expected);
  });

  test('indexes agree with each other', () => {
    expect(snapshot.byId.size).toBe(snapshot.models.length);

    const byProvider = [...snapshot.byProvider.values()].reduce((acc, list) => acc + list.length, 0);
    expect(byProvider).toBe(snapshot.models.length);

    const withMode = snapshot.models.filter((m) => typeof m.mode === 'string').length;
    const byMode = [...snapshot.byMode.values()].reduce((acc, list) => acc + list.length, 0);
    expect(byMode).toBe(withMode);

    for (const [lower, bucket] of snapshot.byLowerId) {
      for (const model of bucket) expect(model.id.toLowerCase()).toBe(lower);
    }
  });

  test('every rate the catalog understands is a finite, non-negative number', () => {
    const offenders: string[] = [];
    for (const model of snapshot.models) {
      for (const [key, value] of Object.entries(model)) {
        if (!key.includes('cost')) continue;
        // Some pricing keys are legitimately objects (`search_context_cost_per_query`,
        // `tiered_pricing`); the rule is for the scalar ones.
        if (typeof value !== 'number') continue;
        if (!Number.isFinite(value) || value < 0) offenders.push(`${model.id}.${key}=${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the engine prices every model without throwing', () => {
    // A generic request that touches the common components. The point is not the amount: it is
    // that no entry upstream can publish makes the estimator crash.
    const usage: EstimateInput['usage'] = {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_read_tokens: 100,
      cache_creation_tokens: 100,
    };
    const options: EstimateInput['options'] = {
      tier_policy: 'flag',
      threshold_basis: 'input_plus_cache',
      cache_tokens_included_in_input: false,
      limit_policy: 'warn',
      transcription_billing: 'both',
      round_to: 10,
    };

    for (const model of snapshot.models) {
      const result = estimate({ model, usage, serviceTier: 'standard', regionProcessing: 'global', options });
      expect(result.totals['USD']).toBeDefined();
      for (const line of result.lines) {
        expect(Number.isFinite(Number(line.amount))).toBe(true);
        expect(typeof model[line.rate_key]).toBe('number');
      }
    }
  });
});
