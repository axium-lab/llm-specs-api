/**
 * Golden fixtures for the cost engine, worked out by hand against `test/fixtures/dataset.ts`.
 * Every test spells out the expected arithmetic so a behaviour change is obvious.
 *
 * None of this touches `data/`: the vendored dataset changes daily, and a pricing rule has to be
 * provable against rates that do not move under the test.
 */

import { describe, expect, test } from 'bun:test';
import { estimate } from '../src/pricing/estimate.ts';
import { buildSnapshot } from '../src/data/store.ts';
import type { EstimateInput, EstimateResult } from '../src/pricing/estimate.ts';
import type { ModelEntry } from '../src/types.ts';
import {
  AUDIO,
  BATCH,
  BATCH_TIERED,
  DBU,
  EMBEDDING,
  FIXTURE_JSON,
  IMAGE,
  PROVISIONED,
  SUSPICIOUS,
  TIERED,
} from './fixtures/dataset.ts';

const { byId } = buildSnapshot(FIXTURE_JSON);

const DEFAULTS: EstimateInput['options'] = {
  tier_policy: 'flag',
  threshold_basis: 'input_plus_cache',
  cache_tokens_included_in_input: false,
  limit_policy: 'warn',
  transcription_billing: 'both',
  round_to: 10,
};

function run(id: string, usage: EstimateInput['usage'], overrides: Partial<EstimateInput> = {}): EstimateResult {
  const model = byId.get(id);
  if (!model) throw new Error(`Model not found in the fixture: ${id}`);
  return estimate({
    model,
    usage,
    serviceTier: 'standard',
    regionProcessing: 'global',
    options: DEFAULTS,
    ...overrides,
  });
}

/** Runs the engine over a one-off variation of a fixture model. */
function runVariant(id: string, patch: Partial<ModelEntry>, usage: EstimateInput['usage']): EstimateResult {
  const model = byId.get(id);
  if (!model) throw new Error(`Model not found in the fixture: ${id}`);
  return estimate({
    model: { ...model, ...patch, id: `${id}#variant` },
    usage,
    serviceTier: 'standard',
    regionProcessing: 'global',
    options: DEFAULTS,
  });
}

const lineFor = (r: EstimateResult, id: string) => r.lines.find((l) => l.id === id);

describe('base rates', () => {
  test('input + output below the threshold uses the base keys', () => {
    const r = run(TIERED, { input_tokens: 10_000, output_tokens: 1_000 });

    // 10000 * 3e-6 = 0.03 ; 1000 * 1.5e-5 = 0.015 ; total 0.045
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token');
    expect(lineFor(r, 'input.text')?.amount).toBe('0.03');
    expect(lineFor(r, 'output.text')?.amount).toBe('0.015');
    expect(r.totals['USD']?.exact).toBe('0.045');
    expect(r.resolution.context_tier_applied).toBeNull();
  });
});

describe('context tier as a FLAG', () => {
  test('crossing 200k reprices the output too, not just the input', () => {
    const r = run(TIERED, { input_tokens: 210_000, output_tokens: 1_000 });

    expect(r.resolution.context_tier_applied).toBe('above_200k_tokens');
    // input: 210000 * 6e-6 = 1.26  (twice the base rate)
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token_above_200k_tokens');
    expect(lineFor(r, 'input.text')?.amount).toBe('1.26');
    // The proof that it is a flag: the OUTPUT goes up too, even though the threshold is on input.
    expect(lineFor(r, 'output.text')?.rate_key).toBe('output_cost_per_token_above_200k_tokens');
    expect(lineFor(r, 'output.text')?.amount).toBe('0.0225');
  });

  test('cached tokens count towards the threshold', () => {
    // 190k of input + 20k of cache read = 210k > 200k
    const r = run(TIERED, {
      input_tokens: 190_000,
      cache_read_tokens: 20_000,
      output_tokens: 1_000,
    });
    expect(r.resolution.threshold_tokens_considered).toBe(210_000);
    expect(r.resolution.context_tier_applied).toBe('above_200k_tokens');
  });

  test('with threshold_basis=input_only the same tokens do NOT trigger the tier', () => {
    const r = run(
      TIERED,
      { input_tokens: 190_000, cache_read_tokens: 20_000, output_tokens: 1_000 },
      { options: { ...DEFAULTS, threshold_basis: 'input_only' } },
    );
    expect(r.resolution.threshold_tokens_considered).toBe(190_000);
    expect(r.resolution.context_tier_applied).toBeNull();
  });

  test('a model with no long-context rate uses the base rate and says so', () => {
    const r = run(BATCH, { input_tokens: 300_000, output_tokens: 1_000 });
    expect(r.resolution.context_tier_applied).toBeNull();
    expect(r.resolution.context_tier_thresholds_available).toEqual([]);
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token');
    // Nothing was degraded: the model never declared a tier, so there is nothing to warn about.
    expect(r.warnings.some((w) => w.code === 'CONTEXT_TIER_NOT_PRICED')).toBe(false);
  });
});

describe('cache TTL', () => {
  test('`_above_1hr` is a TTL, not a volume threshold', () => {
    const r = run(TIERED, {
      input_tokens: 1_000,
      cache_creation_tokens_by_ttl: { '5m': 4_000, '1h': 8_000 },
    });

    // 5m -> 3.75e-6 (1.25x the base) ; 1h -> 6e-6 (2x the base)
    expect(lineFor(r, 'cache_write.5m')?.rate_key).toBe('cache_creation_input_token_cost');
    expect(lineFor(r, 'cache_write.5m')?.amount).toBe('0.015');
    expect(lineFor(r, 'cache_write.1h')?.rate_key).toBe('cache_creation_input_token_cost_above_1hr');
    expect(lineFor(r, 'cache_write.1h')?.amount).toBe('0.048');
  });

  test('the 1h TTL composes with the context tier', () => {
    const r = run(TIERED, {
      input_tokens: 250_000,
      cache_creation_tokens_by_ttl: { '1h': 1_000 },
    });
    // 1000 * 1.2e-5 = 0.012
    expect(lineFor(r, 'cache_write.1h')?.rate_key).toBe(
      'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
    );
    expect(lineFor(r, 'cache_write.1h')?.amount).toBe('0.012');
  });
});

describe('service tiers', () => {
  test('batch uses the _batches keys', () => {
    const r = run(BATCH, { input_tokens: 1_000, output_tokens: 1_000 }, { serviceTier: 'batch' });
    // 1000 * 1.25e-6 = 0.00125
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token_batches');
    expect(lineFor(r, 'input.text')?.amount).toBe('0.00125');
    expect(lineFor(r, 'output.text')?.rate_key).toBe('output_cost_per_token_batches');
    expect(r.resolution.service_tier_applied).toBe('batch');
  });

  test('a model with no batch rate degrades to standard with a warning', () => {
    const r = run(TIERED, { input_tokens: 1_000 }, { serviceTier: 'batch' });
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token');
    expect(r.resolution.service_tier_applied).toBe('standard');
    expect(r.warnings.some((w) => w.code === 'SERVICE_TIER_NOT_PRICED')).toBe(true);
  });

  test('the service tier composes with the context tier when the model prices both', () => {
    // Upstream publishes `input_cost_per_token_above_272k_tokens_batches` on some models: a
    // batch request over the threshold must land on that key, not degrade to either axis alone.
    const r = run(BATCH_TIERED, { input_tokens: 300_000, output_tokens: 1_000 }, { serviceTier: 'batch' });

    expect(r.resolution.context_tier_applied).toBe('above_272k_tokens');
    expect(r.resolution.service_tier_applied).toBe('batch');
    // 300000 * 2.5e-6 = 0.75 ; 1000 * 1.125e-5 = 0.01125
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token_above_272k_tokens_batches');
    expect(lineFor(r, 'input.text')?.amount).toBe('0.75');
    expect(lineFor(r, 'output.text')?.rate_key).toBe('output_cost_per_token_above_272k_tokens_batches');
    expect(lineFor(r, 'output.text')?.amount).toBe('0.01125');
    expect(r.warnings.some((w) => w.code === 'SERVICE_TIER_NOT_PRICED')).toBe(false);
    expect(r.warnings.some((w) => w.code === 'CONTEXT_TIER_NOT_PRICED')).toBe(false);
  });

  test('the context tier survives when only the service tier is missing on the tiered key', () => {
    // Same model, priority tier: it has no `_priority` keys at all, so the service tier is
    // dropped first and the long-context rate is kept. The tier changes the price ~2x; the queue
    // is the cheaper thing to lose.
    const r = run(BATCH_TIERED, { input_tokens: 300_000 }, { serviceTier: 'priority' });
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token_above_272k_tokens');
    // 300000 * 5e-6 = 1.5
    expect(lineFor(r, 'input.text')?.amount).toBe('1.5');
    expect(r.resolution.service_tier_applied).toBe('standard');
    expect(r.warnings.some((w) => w.code === 'SERVICE_TIER_NOT_PRICED')).toBe(true);
  });
});

describe('calculation safety rules', () => {
  test('reasoning_tokens is subtracted from output so it is not billed twice', () => {
    const r = run(TIERED, { output_tokens: 1_000, reasoning_tokens: 400 });
    expect(lineFor(r, 'output.text')?.quantity).toBe(600);
    expect(lineFor(r, 'output.reasoning')?.quantity).toBe(400);
    // 600*1.5e-5 + 400*1.5e-5 = 0.015 — the total matches billing the 1000 tokens just once.
    expect(r.totals['USD']?.exact).toBe('0.015');
  });

  test('a missing rate produces `unpriced`, never a 0 charge', () => {
    // Provisioned throughput models only carry a per-second cost.
    const r = run(PROVISIONED, { input_tokens: 5_000 });
    expect(r.unpriced.some((u) => u.usage_field === 'input_tokens')).toBe(true);
    expect(r.lines.some((l) => l.id === 'input.text')).toBe(false);
    expect(r.totals['USD']?.exact).toBe('0');
  });

  test('a rate that is present and 0 does produce a line with amount 0', () => {
    const r = runVariant(TIERED, { output_cost_per_token: 0 }, { output_tokens: 1_000 });
    expect(lineFor(r, 'output.text')?.amount).toBe('0');
    expect(r.unpriced).toHaveLength(0);
  });

  test('detects suspicious rate magnitudes coming from upstream', () => {
    const r = run(SUSPICIOUS, { input_tokens: 100 });
    expect(r.warnings.some((w) => w.code === 'SUSPICIOUS_RATE_MAGNITUDE')).toBe(true);
  });

  test('a sane rate is not flagged', () => {
    const r = run(TIERED, { input_tokens: 100 });
    expect(r.warnings.some((w) => w.code === 'SUSPICIOUS_RATE_MAGNITUDE')).toBe(false);
  });

  test('DBU rates are never added to USD', () => {
    // No usage field maps to `*_dbu_cost_per_token` today, so the DBU rate is simply not billed.
    // The rule that matters is the negative one: a DBU amount must never land in the USD total.
    const r = run(DBU, { input_tokens: 1_000, output_tokens: 1_000 });
    expect(Object.keys(r.totals)).toEqual(['USD']);
    // 1000 * 1.0003e-7 = 0.00010003
    expect(r.totals['USD']?.exact).toBe('0.00010003');
    expect(r.lines.every((l) => l.currency === 'USD')).toBe(true);
  });

  test('warns about a cache write below the provider minimum', () => {
    const r = run(TIERED, { cache_creation_tokens: 100 });
    expect(r.warnings.some((w) => w.code === 'CACHE_BELOW_MIN_TOKENS')).toBe(true);
  });

  test('warns when max_input_tokens is exceeded without failing', () => {
    const r = run(TIERED, { input_tokens: 250_000 });
    expect(r.warnings.some((w) => w.code === 'EXCEEDS_MAX_INPUT_TOKENS')).toBe(true);
    expect(r.totals['USD']?.exact).not.toBe('0');
  });
});

describe('decimal precision', () => {
  test('does not accumulate floating point error over repeated sums', () => {
    const r = runVariant(TIERED, { input_cost_per_token: 1.1e-7 }, { input_tokens: 333 });
    // 333 * 1.1e-7 = 0.00003663 exactly. In float it comes out as 0.000036630000000000004.
    expect(lineFor(r, 'input.text')?.amount).toBe('0.00003663');
  });

  test('preserves tiny rates without collapsing them to zero', () => {
    const r = runVariant(TIERED, { input_cost_per_token: 1.3e-10 }, { input_tokens: 1 });
    expect(lineFor(r, 'input.text')?.amount).toBe('1.3e-10');
  });
});

describe('other modes', () => {
  test('embedding bills the input only', () => {
    const r = run(EMBEDDING, { input_tokens: 1_000_000 });
    // 1000000 * 2e-8 = 0.02
    expect(lineFor(r, 'input.text')?.amount).toBe('0.02');
    expect(r.lines).toHaveLength(1);
  });

  test('image_generation per pixel from the dimensions', () => {
    const r = run(IMAGE, { image_dimensions: { width: 1024, height: 1024 } });
    expect(lineFor(r, 'input.pixels')?.unit).toBe('pixel');
    expect(lineFor(r, 'input.pixels')?.quantity).toBe(1_048_576);
    expect(lineFor(r, 'input.pixels')?.rate_key).toBe('input_cost_per_pixel');
  });

  test('audio_transcription bills per second, input and output', () => {
    const r = run(AUDIO, { audio_seconds: 600 });
    const line = lineFor(r, 'input.audio_seconds');
    expect(line?.unit).toBe('second');
    expect(line?.rate_key).toBe('input_cost_per_second');
    // 600 * 1e-4 = 0.06 on each side
    expect(line?.amount).toBe('0.06');
    expect(lineFor(r, 'output.audio_seconds')?.amount).toBe('0.06');
    expect(r.totals['USD']?.exact).toBe('0.12');
  });
});
