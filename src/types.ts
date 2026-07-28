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
