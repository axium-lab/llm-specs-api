/**
 * A hand-written dataset in the normalized on-disk shape (`provider`, not `litellm_provider`).
 *
 * The HTTP and pricing tests run against THIS, never against `data/`. The vendored dataset is
 * refreshed from upstream every day, so any test that names a real model, or counts anything in
 * the real file, breaks on the next refresh for reasons that have nothing to do with the code.
 *
 * Every entry exists for a reason, stated next to it. The rates are round numbers chosen so that
 * the expected amounts in `test/estimate.test.ts` can be re-derived by hand; the shapes mirror
 * the ones upstream actually publishes (an Anthropic-style tiered model, an OpenAI-style one
 * with service tiers, Databricks DBUs, per-second provisioned throughput…).
 *
 * Add an entry when a test needs a shape that is not here. Do not reach for `data/`.
 */

import { isModelEntry } from '../../src/types.ts';

/** Chat model with long-context tiers and cache TTLs, Anthropic style. No service tiers. */
export const TIERED = 'chat-tiered';
/** Chat model with service tiers (`_batches`, `_priority`), OpenAI style. No context tiers. */
export const BATCH = 'beta/us.chat-batch-20240806-v1:0';
/** Chat model that declares BOTH axes, context tier and service tier, on the same key. */
export const BATCH_TIERED = 'beta/chat-batch-tiered';
/** Embedding model, with an id that ends in `/`: unreachable by path, only through `by-id`. */
export const EMBEDDING = 'delta/accounts/delta/models/';
/** Image generation priced per pixel, with a 4-segment id. */
export const IMAGE = '1024-x-1024/50-steps/beta/image-per-pixel';
/** Transcription priced per second, input and output. */
export const AUDIO = 'audio-per-second';
/** Provisioned throughput: only per-second rates, no per-token rate at all. Literal `*` in the id. */
export const PROVISIONED = 'beta/*/1-month-commitment/provisioned-per-second';
/** A model with no pricing key whatsoever. */
export const UNPRICED = 'gamma/chat-unpriced';
/** Databricks style: USD rates for reference, DBU rates as the real price. */
export const DBU = 'dbu-embedding';
/** A per-token rate above $500/MTok, the kind of upstream typo the engine flags. */
export const SUSPICIOUS = 'gamma/suspicious-rate';
/** Two entries that differ only by case, as upstream ships them. */
export const CASE_LOWER = 'epsilon/baai/embedding-case';
export const CASE_UPPER = 'epsilon/BAAI/embedding-case';
/** An entry without `mode`. */
export const NO_MODE = 'gamma/no-mode';

export const FIXTURE_DATASET: Record<string, Record<string, unknown>> = {
  sample_spec: {
    input_cost_per_token: 0,
    provider: 'one of https://docs.litellm.ai/docs/providers',
    mode: 'one of: chat, embedding',
  },

  [TIERED]: {
    provider: 'alpha',
    mode: 'chat',
    max_input_tokens: 200_000,
    max_output_tokens: 64_000,
    max_tokens: 64_000,
    input_cost_per_token: 0.000003,
    input_cost_per_token_above_200k_tokens: 0.000006,
    output_cost_per_token: 0.000015,
    output_cost_per_token_above_200k_tokens: 0.0000225,
    cache_read_input_token_cost: 3e-7,
    cache_read_input_token_cost_above_200k_tokens: 6e-7,
    cache_creation_input_token_cost: 0.00000375,
    cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
    cache_creation_input_token_cost_above_1hr: 0.000006,
    cache_creation_input_token_cost_above_1hr_above_200k_tokens: 0.000012,
    prompt_cache_min_tokens: 1024,
    supports_prompt_caching: true,
    supports_vision: true,
    supports_function_calling: true,
  },

  [BATCH]: {
    provider: 'beta',
    mode: 'chat',
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
    max_tokens: 16_384,
    input_cost_per_token: 0.0000025,
    input_cost_per_token_batches: 0.00000125,
    input_cost_per_token_priority: 0.00000425,
    output_cost_per_token: 0.00001,
    output_cost_per_token_batches: 0.000005,
    output_cost_per_token_priority: 0.000017,
    cache_read_input_token_cost: 0.00000125,
    cache_read_input_token_cost_priority: 0.000002125,
    supports_vision: true,
    supports_function_calling: true,
  },

  [BATCH_TIERED]: {
    provider: 'beta',
    mode: 'chat',
    max_input_tokens: 922_000,
    max_output_tokens: 128_000,
    input_cost_per_token: 0.0000025,
    input_cost_per_token_above_272k_tokens: 0.000005,
    input_cost_per_token_batches: 0.00000125,
    input_cost_per_token_above_272k_tokens_batches: 0.0000025,
    output_cost_per_token: 0.000015,
    output_cost_per_token_above_272k_tokens: 0.0000225,
    output_cost_per_token_batches: 0.0000075,
    output_cost_per_token_above_272k_tokens_batches: 0.00001125,
    supports_vision: false,
  },

  [EMBEDDING]: {
    provider: 'delta',
    mode: 'embedding',
    max_input_tokens: 8191,
    max_tokens: 8191,
    input_cost_per_token: 2e-8,
    input_cost_per_token_batches: 1e-8,
    output_cost_per_token: 0,
    output_cost_per_token_batches: 0,
    output_vector_size: 1536,
  },

  [IMAGE]: {
    provider: 'beta',
    mode: 'image_generation',
    input_cost_per_pixel: 1.9e-8,
    output_cost_per_pixel: 0,
  },

  [AUDIO]: {
    provider: 'alpha',
    mode: 'audio_transcription',
    input_cost_per_second: 0.0001,
    output_cost_per_second: 0.0001,
  },

  [PROVISIONED]: {
    provider: 'beta',
    mode: 'chat',
    max_input_tokens: 100_000,
    max_output_tokens: 8191,
    max_tokens: 8191,
    input_cost_per_second: 0.0175,
    output_cost_per_second: 0.0175,
  },

  [UNPRICED]: {
    provider: 'gamma',
    mode: 'chat',
    max_input_tokens: 64_000,
    max_output_tokens: 4096,
    max_tokens: 4096,
    supports_function_calling: true,
    supports_vision: true,
  },

  [DBU]: {
    provider: 'dbu',
    mode: 'embedding',
    max_input_tokens: 512,
    max_tokens: 512,
    input_cost_per_token: 1.0003e-7,
    input_dbu_cost_per_token: 0.000001429,
    output_cost_per_token: 0,
    output_dbu_cost_per_token: 0,
    output_vector_size: 1024,
  },

  [SUSPICIOUS]: {
    provider: 'gamma',
    mode: 'chat',
    max_input_tokens: 8192,
    max_output_tokens: 8192,
    max_tokens: 8192,
    input_cost_per_token: 0.0032,
    output_cost_per_token: 0.00971,
  },

  [CASE_LOWER]: {
    provider: 'epsilon',
    mode: 'embedding',
    max_input_tokens: 512,
    input_cost_per_token: 8e-9,
    output_cost_per_token: 0,
    output_vector_size: 768,
  },

  [CASE_UPPER]: {
    provider: 'epsilon',
    mode: 'embedding',
    max_input_tokens: 512,
    input_cost_per_token: 8e-9,
    output_cost_per_token: 0,
    output_vector_size: 768,
  },

  [NO_MODE]: {
    provider: 'gamma',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },

  fallback_generalizations: {
    rules: [{ name: 'beta-ids', model_info: { provider: 'beta' } }],
  },
};

export const FIXTURE_JSON = JSON.stringify(FIXTURE_DATASET);

/** The entries the service treats as models, i.e. everything but `sample_spec` and friends. */
export const FIXTURE_MODELS = Object.entries(FIXTURE_DATASET).filter(([k, v]) => isModelEntry(k, v));
