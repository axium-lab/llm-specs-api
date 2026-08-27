import { describe, expect, test } from 'bun:test';
import {
  COST_KEY_ALIASES,
  NON_RATE_PRICING_KEYS,
  buildCostKey,
  looksLikePricingKey,
  parseCostKey,
} from '../src/pricing/catalog.ts';
import { isModelEntry } from '../src/types.ts';
import raw from '../data/model_prices_and_context_window.json' with { type: 'json' };

const dataset = raw as Record<string, unknown>;
const models = Object.entries(dataset).filter(([k, v]) => isModelEntry(k, v));

describe('cost key catalog', () => {
  test('the dataset holds 3214 real models', () => {
    expect(models.length).toBe(3214);
  });

  test('excludes sample_spec and fallback_generalizations', () => {
    const ids = new Set(models.map(([k]) => k));
    expect(ids.has('sample_spec')).toBe(false);
    expect(ids.has('fallback_generalizations')).toBe(false);
  });

  /**
   * The completeness test: if LiteLLM adds a cost key the catalog cannot describe, this fails
   * in CI instead of silently ignoring it at billing time.
   */
  test('every pricing key in the dataset is recognized by the catalog', () => {
    const unknown = new Set<string>();

    for (const [, entry] of models) {
      for (const key of Object.keys(entry as object)) {
        if (!looksLikePricingKey(key)) continue;
        if (NON_RATE_PRICING_KEYS.has(key)) continue;
        if (parseCostKey(key) === null) unknown.add(key);
      }
    }

    expect([...unknown].sort()).toEqual([]);
  });

  test('decomposes compound keys correctly', () => {
    expect(parseCostKey('input_cost_per_token')).toMatchObject({
      descriptor: { base: 'input_cost_per_token', unit: 'token', category: 'input' },
    });

    expect(parseCostKey('input_cost_per_token_above_272k_tokens_priority')).toMatchObject({
      ctxThreshold: 272_000,
      svcTier: 'priority',
    });

    // The case that composes cache TTL with context tier.
    expect(parseCostKey('cache_creation_input_token_cost_above_1hr_above_200k_tokens')).toMatchObject({
      ttl: 'above_1hr',
      ctxThreshold: 200_000,
      descriptor: { category: 'cache_write' },
    });

    expect(parseCostKey('input_cost_per_video_per_second_above_15s_interval')).toMatchObject({
      intervalThreshold: 15,
    });

    expect(parseCostKey('output_cost_per_second_1080p')).toMatchObject({ variant: '1080p' });
  });

  test('the longest base wins over the shortest', () => {
    // `input_cost_per_audio_token` must not resolve as `input_cost_per_token`.
    expect(parseCostKey('input_cost_per_audio_token')?.descriptor.base).toBe('input_cost_per_audio_token');
    expect(parseCostKey('output_cost_per_reasoning_token')?.descriptor.base).toBe(
      'output_cost_per_reasoning_token',
    );
  });

  test('DBU keys are not labelled as USD', () => {
    expect(parseCostKey('input_dbu_cost_per_token')?.descriptor.currency).toBe('DBU');
    expect(parseCostKey('input_cost_per_token')?.descriptor.currency).toBe('USD');
  });

  test('the cache_hit alias resolves to the canonical cache read key', () => {
    expect(parseCostKey('input_cost_per_token_cache_hit')?.descriptor.base).toBe(
      'cache_read_input_token_cost',
    );
    expect(COST_KEY_ALIASES['input_cost_per_token_cache_hit']).toBe('cache_read_input_token_cost');
  });

  test('buildCostKey is the inverse of parseCostKey', () => {
    const samples = [
      'input_cost_per_token',
      'input_cost_per_token_above_200k_tokens',
      'input_cost_per_token_above_272k_tokens_priority',
      'cache_creation_input_token_cost_above_1hr',
      'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
      'cache_read_input_token_cost_priority',
    ];

    for (const key of samples) {
      const parsed = parseCostKey(key);
      expect(parsed).not.toBeNull();
      expect(
        buildCostKey(parsed!.descriptor.base, {
          ttl: parsed!.ttl,
          ctxThreshold: parsed!.ctxThreshold,
          svcTier: parsed!.svcTier,
        }),
      ).toBe(key);
    }
  });

  test('`_batches` never combines with `_above_*` in the dataset', () => {
    const offenders = new Set<string>();
    for (const [, entry] of models) {
      for (const key of Object.keys(entry as object)) {
        if (key.includes('above_') && key.endsWith('_batches')) offenders.add(key);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});
