/**
 * Golden fixtures for the cost engine, checked by hand against the JSON.
 * Every test spells out the expected arithmetic so a behaviour change is obvious.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { estimate } from '../src/pricing/estimate.ts';
import { buildSnapshot } from '../src/data/store.ts';
import type { EstimateInput, EstimateResult } from '../src/pricing/estimate.ts';
import type { ModelEntry } from '../src/types.ts';

let byId: Map<string, ModelEntry>;

beforeAll(async () => {
  const json = await Bun.file(
    new URL('../data/model_prices_and_context_window.json', import.meta.url),
  ).text();
  byId = buildSnapshot(json).byId;
});

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
  if (!model) throw new Error(`Model not found in the dataset: ${id}`);
  return estimate({
    model,
    usage,
    serviceTier: 'standard',
    regionProcessing: 'global',
    options: DEFAULTS,
    ...overrides,
  });
}

const lineFor = (r: EstimateResult, id: string) => r.lines.find((l) => l.id === id);

describe('claude-sonnet-4-5 — base rates', () => {
  test('input + output below the threshold uses the base keys', () => {
    const r = run('claude-sonnet-4-5', { input_tokens: 10_000, output_tokens: 1_000 });

    // 10000 * 3e-6 = 0.03 ; 1000 * 1.5e-5 = 0.015 ; total 0.045
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token');
    expect(lineFor(r, 'input.text')?.amount).toBe('0.03');
    expect(lineFor(r, 'output.text')?.amount).toBe('0.015');
    expect(r.totals['USD']?.exact).toBe('0.045');
    expect(r.resolution.context_tier_applied).toBeNull();
  });
});

describe('claude-sonnet-4-5 — context tier as a FLAG', () => {
  test('crossing 200k reprices the output too, not just the input', () => {
    const r = run('claude-sonnet-4-5', { input_tokens: 210_000, output_tokens: 1_000 });

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
    const r = run('claude-sonnet-4-5', {
      input_tokens: 190_000,
      cache_read_tokens: 20_000,
      output_tokens: 1_000,
    });
    expect(r.resolution.threshold_tokens_considered).toBe(210_000);
    expect(r.resolution.context_tier_applied).toBe('above_200k_tokens');
  });

  test('with threshold_basis=input_only the same tokens do NOT trigger the tier', () => {
    const r = run(
      'claude-sonnet-4-5',
      { input_tokens: 190_000, cache_read_tokens: 20_000, output_tokens: 1_000 },
      { options: { ...DEFAULTS, threshold_basis: 'input_only' } },
    );
    expect(r.resolution.threshold_tokens_considered).toBe(190_000);
    expect(r.resolution.context_tier_applied).toBeNull();
  });
});

describe('claude-sonnet-4-5 — cache TTL', () => {
  test('`_above_1hr` is a TTL, not a volume threshold', () => {
    const r = run('claude-sonnet-4-5', {
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
    const r = run('claude-sonnet-4-5', {
      input_tokens: 250_000,
      cache_creation_tokens_by_ttl: { '1h': 1_000 },
    });
    expect(lineFor(r, 'cache_write.1h')?.rate_key).toBe(
      'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
    );
    expect(lineFor(r, 'cache_write.1h')?.amount).toBe('0.012');
  });
});

describe('service tiers', () => {
  test('gpt-4o on batch uses the _batches keys', () => {
    const r = run('gpt-4o', { input_tokens: 1_000, output_tokens: 1_000 }, { serviceTier: 'batch' });
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token_batches');
    expect(lineFor(r, 'input.text')?.amount).toBe('0.00125');
    expect(lineFor(r, 'output.text')?.rate_key).toBe('output_cost_per_token_batches');
  });

  test('a model with no batch rate degrades to standard with a warning', () => {
    const r = run('claude-sonnet-4-5', { input_tokens: 1_000 }, { serviceTier: 'batch' });
    expect(lineFor(r, 'input.text')?.rate_key).toBe('input_cost_per_token');
    expect(r.resolution.service_tier_applied).toBe('standard');
    expect(r.warnings.some((w) => w.code === 'SERVICE_TIER_NOT_PRICED')).toBe(true);
  });
});

describe('calculation safety rules', () => {
  test('reasoning_tokens is subtracted from output so it is not billed twice', () => {
    const r = run('claude-sonnet-4-5', { output_tokens: 1_000, reasoning_tokens: 400 });
    expect(lineFor(r, 'output.text')?.quantity).toBe(600);
    expect(lineFor(r, 'output.reasoning')?.quantity).toBe(400);
    // 600*1.5e-5 + 400*1.5e-5 = 0.015 — the total matches billing the 1000 tokens just once.
    expect(r.totals['USD']?.exact).toBe('0.015');
  });

  test('a missing rate produces `unpriced`, never a 0 charge', () => {
    // Provisioned throughput models only carry a per-second cost.
    const id = 'bedrock/us-east-1/1-month-commitment/anthropic.claude-v1';
    const r = run(id, { input_tokens: 5_000 });
    expect(r.unpriced.some((u) => u.usage_field === 'input_tokens')).toBe(true);
    expect(r.lines.some((l) => l.id === 'input.text')).toBe(false);
  });

  test('a rate that is present and 0 does produce a line with amount 0', () => {
    const model = byId.get('claude-sonnet-4-5')!;
    const free: ModelEntry = { ...model, id: 'test-free', output_cost_per_token: 0 };
    const r = estimate({
      model: free,
      usage: { output_tokens: 1_000 },
      serviceTier: 'standard',
      regionProcessing: 'global',
      options: DEFAULTS,
    });
    expect(lineFor(r, 'output.text')?.amount).toBe('0');
    expect(r.unpriced).toHaveLength(0);
  });

  test('detects suspicious rate magnitudes coming from upstream', () => {
    const suspicious = [...byId.values()].find(
      (m) => typeof m['input_cost_per_token'] === 'number' && (m['input_cost_per_token'] as number) > 5e-4,
    );
    expect(suspicious).toBeDefined();
    const r = run(suspicious!.id, { input_tokens: 100 });
    expect(r.warnings.some((w) => w.code === 'SUSPICIOUS_RATE_MAGNITUDE')).toBe(true);
  });

  test('DBU rates are not added to USD', () => {
    const databricks = [...byId.values()].find((m) => typeof m['input_dbu_cost_per_token'] === 'number');
    expect(databricks).toBeDefined();
    const r = run(databricks!.id, { input_tokens: 1_000, output_tokens: 1_000 });
    if (Object.keys(r.totals).length > 1) {
      expect(r.totals['DBU']).toBeDefined();
      expect(r.warnings.some((w) => w.code === 'MIXED_CURRENCY_TOTALS')).toBe(true);
    }
  });

  test('warns about a cache write below the provider minimum', () => {
    const r = run('claude-sonnet-4-5', { cache_creation_tokens: 100 });
    expect(r.warnings.some((w) => w.code === 'CACHE_BELOW_MIN_TOKENS')).toBe(true);
  });

  test('warns when max_input_tokens is exceeded without failing', () => {
    const r = run('claude-sonnet-4-5', { input_tokens: 250_000 });
    expect(r.warnings.some((w) => w.code === 'EXCEEDS_MAX_INPUT_TOKENS')).toBe(true);
    expect(r.totals['USD']?.exact).not.toBe('0');
  });
});

describe('decimal precision', () => {
  test('does not accumulate floating point error over repeated sums', () => {
    const model = byId.get('claude-sonnet-4-5')!;
    const noisy: ModelEntry = { ...model, id: 'test-noisy', input_cost_per_token: 1.1e-7 };
    const r = estimate({
      model: noisy,
      usage: { input_tokens: 333 },
      serviceTier: 'standard',
      regionProcessing: 'global',
      options: DEFAULTS,
    });
    // 333 * 1.1e-7 = 0.00003663 exactly. In float it comes out as 0.000036630000000000004.
    expect(lineFor(r, 'input.text')?.amount).toBe('0.00003663');
  });

  test('preserves tiny rates without collapsing them to zero', () => {
    const model = byId.get('claude-sonnet-4-5')!;
    const tiny: ModelEntry = { ...model, id: 'test-tiny', input_cost_per_token: 1.3e-10 };
    const r = estimate({
      model: tiny,
      usage: { input_tokens: 1 },
      serviceTier: 'standard',
      regionProcessing: 'global',
      options: DEFAULTS,
    });
    expect(lineFor(r, 'input.text')?.amount).toBe('1.3e-10');
  });
});

describe('other modes', () => {
  test('embedding bills the input only', () => {
    const r = run('text-embedding-3-small', { input_tokens: 1_000_000 });
    expect(lineFor(r, 'input.text')?.amount).toBe('0.02');
  });

  test('image_generation per pixel from the dimensions', () => {
    const r = run('1024-x-1024/dall-e-2', { image_dimensions: { width: 1024, height: 1024 } });
    expect(lineFor(r, 'input.pixels')?.unit).toBe('pixel');
    expect(lineFor(r, 'input.pixels')?.quantity).toBe(1_048_576);
  });

  test('audio_transcription bills per second', () => {
    const r = run('whisper-1', { audio_seconds: 600 });
    const line = lineFor(r, 'input.audio_seconds');
    expect(line?.unit).toBe('second');
    expect(line?.rate_key).toBe('input_cost_per_second');
  });
});
