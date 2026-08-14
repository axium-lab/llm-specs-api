/** Shared types for the dataset and the API. */

/** A model entry exactly as it comes from the LiteLLM JSON, plus the `id` we inject. */
export interface ModelEntry {
  id: string;
  litellm_provider: string;
  mode?: string;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  deprecation_date?: string;
  tiered_pricing?: TieredPricingBand[];
  search_context_cost_per_query?: Record<string, number>;
  prompt_cache_min_tokens?: number;
  [key: string]: unknown;
}

export interface TieredPricingBand {
  /** Band by input tokens. Half-open: [lo, hi). */
  range?: [number, number];
  /** Band by number of search results. Closed: [lo, hi]. */
  max_results_range?: [number, number];
  [costKey: string]: unknown;
}

/** The only two entries in the JSON that are NOT models. */
export const NON_MODEL_KEYS = new Set(['sample_spec', 'fallback_generalizations']);

/**
 * `sample_spec` DOES have `litellm_provider` (holding a descriptive value, not a real provider),
 * which is why it has to be excluded by name and not just by shape.
 *
 * The narrowed type is spelled out instead of using `Omit<ModelEntry, 'id'>`: because
 * `ModelEntry` carries an index signature, `Omit` would collapse to `{[k: string]: unknown}`
 * and lose `litellm_provider`.
 */
export function isModelEntry(
  key: string,
  value: unknown,
): value is Record<string, unknown> & { litellm_provider: string } {
  return (
    !NON_MODEL_KEYS.has(key) &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'litellm_provider' in value
  );
}

// ---------------------------------------------------------------------------
// Cost primitives
// ---------------------------------------------------------------------------

export type ServiceTier = 'standard' | 'batch' | 'priority' | 'flex';
export type CacheTtl = '5m' | '1h';
export type CurrencyCode = 'USD' | 'DBU';
export type CostCategory =
  | 'input'
  | 'output'
  | 'cache_read'
  | 'cache_write'
  | 'surcharge'
  | 'other';

export type Unit =
  | 'token'
  | 'second'
  | 'character'
  | 'image'
  | 'pixel'
  | 'page'
  | 'query'
  | 'request'
  | 'session'
  | 'credit';

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  /** Subset of output_tokens. Subtracted before billing so it is not charged twice. */
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_tokens_by_ttl?: Partial<Record<CacheTtl, number>>;

  input_audio_tokens?: number;
  output_audio_tokens?: number;
  cache_read_audio_tokens?: number;
  cache_creation_audio_tokens?: number;
  input_image_tokens?: number;
  output_image_tokens?: number;
  output_video_tokens?: number;

  input_characters?: number;
  output_characters?: number;
  audio_seconds?: number;
  output_audio_seconds?: number;
  video_seconds?: number;
  output_video_seconds?: number;
  input_images?: number;
  output_images?: number;
  image_dimensions?: { width: number; height: number; count?: number };
  input_pixels?: number;
  output_pixels?: number;
  pages?: number;
  annotated_pages?: number;
  requests?: number;
  queries?: number;
  search_results?: number;
  code_interpreter_sessions?: number;
  web_search?: { queries: number; context_size?: 'low' | 'medium' | 'high' };
}

export interface EstimateOptions {
  tier_policy?: 'flag' | 'marginal';
  threshold_basis?: 'input_only' | 'input_plus_cache';
  cache_tokens_included_in_input?: boolean;
  limit_policy?: 'error' | 'warn' | 'ignore';
  transcription_billing?: 'input_only' | 'both';
  round_to?: number;
}

export interface CostLine {
  id: string;
  label: string;
  category: CostCategory;
  currency: CurrencyCode;
  quantity: number;
  unit: Unit;
  /** The rate exactly as it appears in the JSON, as an exact decimal string. */
  rate: string;
  /** The literal dataset key — lets the calculation be audited against the file. */
  rate_key: string;
  /** How many units one rate covers. 1 except for the `_per_1k_*` keys, which are 1000. */
  rate_per_units: number;
  amount: string;
  notes?: string[];
}

export type WarningCode =
  | 'SERVICE_TIER_NOT_PRICED'
  | 'CONTEXT_TIER_NOT_PRICED'
  | 'RATE_FALLBACK_APPLIED'
  | 'ALIAS_KEY_USED'
  | 'EXCEEDS_MAX_INPUT_TOKENS'
  | 'EXCEEDS_MAX_OUTPUT_TOKENS'
  | 'SUSPICIOUS_RATE_MAGNITUDE'
  | 'DEPRECATED_MODEL'
  | 'CACHE_BELOW_MIN_TOKENS'
  | 'MIXED_CURRENCY_TOTALS'
  | 'TIERED_PRICING_APPLIED';

export interface EstimateWarning {
  code: WarningCode;
  message: string;
  field?: string;
  detail?: Record<string, unknown>;
}

export interface UnpricedItem {
  usage_field: string;
  quantity: number;
  reason: 'NO_RATE_KEY' | 'MODE_MISMATCH' | 'NON_MONETARY_UNIT';
  candidate_keys_checked: string[];
}

export interface MoneyTotal {
  exact: string;
  rounded: string;
  decimals: number;
}
