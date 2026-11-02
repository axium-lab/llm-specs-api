/** The cost key grammar: pure unit tests, no dataset involved. */

import { describe, expect, test } from 'bun:test';
import {
  COST_KEY_ALIASES,
  buildCostKey,
  looksLikePricingKey,
  parseCostKey,
} from '../src/pricing/catalog.ts';

describe('cost key catalog', () => {
  test('decomposes compound keys correctly', () => {
    expect(parseCostKey('input_cost_per_token')).toMatchObject({
      descriptor: { base: 'input_cost_per_token', unit: 'token', category: 'input' },
    });

    expect(parseCostKey('input_cost_per_token_above_272k_tokens_priority')).toMatchObject({
      ctxThreshold: 272_000,
      svcTier: 'priority',
    });

    // Upstream does publish the context tier and the batch queue on one key.
    expect(parseCostKey('input_cost_per_token_above_272k_tokens_batches')).toMatchObject({
      ctxThreshold: 272_000,
      svcTier: 'batches',
      descriptor: { base: 'input_cost_per_token' },
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

  test('rejects what it cannot describe instead of guessing', () => {
    expect(parseCostKey('max_input_tokens')).toBeNull();
    expect(parseCostKey('input_cost_per_token_above_200k_tokens_turbo')).toBeNull();
    expect(parseCostKey('input_cost_per_token_above_200k_tokens_batches_priority')).toBeNull();
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
      'input_cost_per_token_above_272k_tokens_batches',
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

  test('looksLikePricingKey separates rates from the rest of an entry', () => {
    expect(looksLikePricingKey('input_cost_per_token')).toBe(true);
    expect(looksLikePricingKey('cache_read_input_token_cost')).toBe(true);
    expect(looksLikePricingKey('tiered_pricing')).toBe(true);
    expect(looksLikePricingKey('max_input_tokens')).toBe(false);
    expect(looksLikePricingKey('supports_vision')).toBe(false);
  });
});
