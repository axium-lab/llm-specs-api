/**
 * Catalog of the cost keys used by the LiteLLM dataset.
 *
 * The dataset uses TWO incompatible syntactic families for the same thing:
 *
 *   Family A:  <direction>_cost_per_<unit>[suffixes]         -> input_cost_per_token_above_272k_tokens_priority
 *   Family B:  cache_<op>_input[_<mod>]_token_cost[suffixes] -> cache_creation_input_token_cost_above_1hr
 *
 * In family B the `_cost` comes LAST. A parser built around a single `*_cost_per_*` regex skips
 * the ~1,100 cache key occurrences. Hence an explicit registry of known bases plus a suffix
 * parser, rather than free-form inference.
 *
 * `test/catalog.test.ts` walks the real dataset and fails if a cost key shows up that this
 * catalog cannot describe: when LiteLLM adds a new one, CI complains instead of ignoring it.
 */

import type { CostCategory, CurrencyCode, Unit } from '../types.ts';

/** The "service tier" axis: which processing queue was used. */
export type SvcTier = 'batches' | 'priority' | 'flex';

/** The "cache TTL" axis. `above_1hr` is NOT a volume threshold: it is Anthropic's 1h TTL. */
export type CacheTtlAxis = 'above_1hr';

export interface CostKeyDescriptor {
  /** Base key, without suffixes. */
  base: string;
  category: CostCategory;
  unit: Unit;
  /** How many units one rate covers: 1000 for the `_per_1k_*` keys. */
  perUnits: number;
  currency: CurrencyCode;
  /** Human-readable label for the breakdown. */
  label: string;
  /** Accepts a context tier suffix (`_above_200k_tokens`). */
  ctxTierable: boolean;
  /** Accepts a service tier suffix (`_batches` / `_priority` / `_flex`). */
  svcTierable: boolean;
  /** Accepts a cache TTL suffix (`_above_1hr`). */
  ttlable: boolean;
}

/** Decomposition of one concrete dataset key. */
export interface ParsedCostKey {
  key: string;
  descriptor: CostKeyDescriptor;
  ttl?: CacheTtlAxis;
  /** Threshold in tokens (200000, 272000…) extracted from `_above_Nk_tokens`. */
  ctxThreshold?: number;
  /** Threshold in seconds extracted from `_above_Ns_interval` (video). */
  intervalThreshold?: number;
  svcTier?: SvcTier;
  /** Resolution variant, e.g. `1080p`. */
  variant?: string;
}

function d(
  base: string,
  label: string,
  category: CostCategory,
  unit: Unit,
  opts: Partial<Pick<CostKeyDescriptor, 'perUnits' | 'currency' | 'ctxTierable' | 'svcTierable' | 'ttlable'>> = {},
): CostKeyDescriptor {
  return {
    base,
    label,
    category,
    unit,
    perUnits: opts.perUnits ?? 1,
    currency: opts.currency ?? 'USD',
    ctxTierable: opts.ctxTierable ?? false,
    svcTierable: opts.svcTierable ?? false,
    ttlable: opts.ttlable ?? false,
  };
}

const TOKEN_TIERABLE = { ctxTierable: true, svcTierable: true } as const;

/**
 * Registry of bases. Order matters in `parseCostKey`: bases are tried from longest to shortest
 * so that `input_cost_per_audio_token` wins over `input_cost_per_token`.
 */
export const COST_KEY_BASES: readonly CostKeyDescriptor[] = [
  // --- Family A: text tokens ---
  d('input_cost_per_token', 'Input tokens', 'input', 'token', TOKEN_TIERABLE),
  d('output_cost_per_token', 'Output tokens', 'output', 'token', TOKEN_TIERABLE),
  d('output_cost_per_reasoning_token', 'Reasoning tokens', 'output', 'token', TOKEN_TIERABLE),
  d('citation_cost_per_token', 'Citation tokens', 'other', 'token'),

  // --- Family A: multimodal tokens ---
  d('input_cost_per_audio_token', 'Input audio tokens', 'input', 'token', { svcTierable: true }),
  d('output_cost_per_audio_token', 'Output audio tokens', 'output', 'token', { svcTierable: true }),
  d('input_cost_per_image_token', 'Input image tokens', 'input', 'token'),
  d('output_cost_per_image_token', 'Output image tokens', 'output', 'token'),
  d('output_cost_per_video_token', 'Output video tokens', 'output', 'token'),

  // --- Family A: non-token units ---
  d('input_cost_per_character', 'Input characters', 'input', 'character', { ctxTierable: true }),
  d('output_cost_per_character', 'Output characters', 'output', 'character', { ctxTierable: true }),
  d('input_cost_per_image', 'Input images', 'input', 'image', { ctxTierable: true }),
  d('output_cost_per_image', 'Output images', 'output', 'image'),
  d('input_cost_per_pixel', 'Input pixels', 'input', 'pixel'),
  d('output_cost_per_pixel', 'Output pixels', 'output', 'pixel'),
  d('input_cost_per_audio_per_second', 'Input audio seconds', 'input', 'second', { ctxTierable: true }),
  d('input_cost_per_video_per_second', 'Input video seconds', 'input', 'second', { ctxTierable: true }),
  d('output_cost_per_video_per_second', 'Output video seconds', 'output', 'second'),
  d('input_cost_per_second', 'Input seconds', 'input', 'second'),
  d('output_cost_per_second', 'Output seconds', 'output', 'second'),
  d('input_cost_per_query', 'Queries', 'input', 'query'),
  d('input_cost_per_request', 'Requests', 'input', 'request'),

  // --- Family B: caches (the `_cost` comes last) ---
  d('cache_read_input_token_cost', 'Cache read', 'cache_read', 'token', TOKEN_TIERABLE),
  d('cache_creation_input_token_cost', 'Cache write', 'cache_write', 'token', {
    ...TOKEN_TIERABLE,
    ttlable: true,
  }),
  d('cache_read_input_audio_token_cost', 'Cache read (audio)', 'cache_read', 'token'),
  d('cache_creation_input_audio_token_cost', 'Cache write (audio)', 'cache_write', 'token'),

  // --- Family C: features ---
  d('ocr_cost_per_page', 'OCR pages', 'other', 'page'),
  d('annotation_cost_per_page', 'Annotated pages', 'other', 'page'),
  d('ocr_cost_per_credit', 'OCR credits', 'other', 'credit'),
  d('code_interpreter_cost_per_session', 'Code interpreter sessions', 'other', 'session'),
  d('search_context_cost_per_query', 'Web search context', 'other', 'query'),
  d('file_search_cost_per_1k_calls', 'File search calls', 'other', 'request', { perUnits: 1000 }),

  // --- Family D: Databricks Units. NOT dollars: never add them to USD. ---
  d('input_dbu_cost_per_token', 'Input tokens (DBU)', 'input', 'token', { currency: 'DBU' }),
  d('output_dbu_cost_per_token', 'Output tokens (DBU)', 'output', 'token', { currency: 'DBU' }),
];

/** Index by base, for direct lookup. */
const BY_BASE = new Map(COST_KEY_BASES.map((x) => [x.base, x]));

/** Bases sorted longest to shortest: keeps a short prefix from capturing a longer key. */
const BASES_BY_LENGTH = [...COST_KEY_BASES].sort((a, b) => b.base.length - a.base.length);

/**
 * Legacy aliases: DeepSeek/OpenRouter publish the cache read rate under a different name.
 * It is THE SAME rate as `cache_read_input_token_cost`; pick one, never add both.
 */
export const COST_KEY_ALIASES: Readonly<Record<string, string>> = {
  input_cost_per_token_cache_hit: 'cache_read_input_token_cost',
};

/** Pricing-related keys that are not rates and are handled separately. */
export const NON_RATE_PRICING_KEYS = new Set(['tiered_pricing']);

const CTX_THRESHOLD_RE = /^above_(\d+)k_tokens$/;
const INTERVAL_RE = /^above_(\d+)s_interval$/;
const SVC_TIERS: readonly SvcTier[] = ['batches', 'priority', 'flex'];

/**
 * Decomposes a dataset key into its axes.
 *
 * Canonical suffix order, verified exhaustively against the dataset (no other order occurs):
 *   <base> [_above_1hr] [_above_Nk_tokens | _above_Ns_interval] [_batches|_priority|_flex]
 *
 * Returns `null` when the key is not a recognizable rate.
 */
export function parseCostKey(key: string): ParsedCostKey | null {
  const canonical = COST_KEY_ALIASES[key];
  if (canonical) {
    const descriptor = BY_BASE.get(canonical);
    if (descriptor) return { key, descriptor };
  }

  const base = BASES_BY_LENGTH.find((b) => key === b.base || key.startsWith(`${b.base}_`));
  if (!base) return null;

  const parsed: ParsedCostKey = { key, descriptor: base };
  if (key === base.base) return parsed;

  let rest = key.slice(base.base.length + 1);

  // Resolution variant (terminal suffix, not combinable).
  if (rest === '1080p') {
    parsed.variant = rest;
    return parsed;
  }

  if (rest.startsWith('above_1hr')) {
    parsed.ttl = 'above_1hr';
    rest = rest.slice('above_1hr'.length).replace(/^_/, '');
  }

  const ctxMatch = rest.match(/^above_\d+k_tokens/)?.[0];
  if (ctxMatch) {
    const m = ctxMatch.match(CTX_THRESHOLD_RE);
    if (m?.[1]) parsed.ctxThreshold = Number.parseInt(m[1], 10) * 1000;
    rest = rest.slice(ctxMatch.length).replace(/^_/, '');
  } else {
    const intervalMatch = rest.match(/^above_\d+s_interval/)?.[0];
    if (intervalMatch) {
      const m = intervalMatch.match(INTERVAL_RE);
      if (m?.[1]) parsed.intervalThreshold = Number.parseInt(m[1], 10);
      rest = rest.slice(intervalMatch.length).replace(/^_/, '');
    }
  }

  if (rest !== '') {
    const svc = SVC_TIERS.find((t) => t === rest);
    if (!svc) return null; // unknown suffix: let the test surface it
    parsed.svcTier = svc;
  }

  return parsed;
}

/** Builds a key from its axes, in canonical order. */
export function buildCostKey(
  base: string,
  axes: { ttl?: CacheTtlAxis; ctxThreshold?: number; svcTier?: SvcTier } = {},
): string {
  let key = base;
  if (axes.ttl) key += `_${axes.ttl}`;
  if (axes.ctxThreshold !== undefined) key += `_above_${axes.ctxThreshold / 1000}k_tokens`;
  if (axes.svcTier) key += `_${axes.svcTier}`;
  return key;
}

/** Does this dataset key look like a pricing key? Used by the completeness test. */
export function looksLikePricingKey(key: string): boolean {
  return key.includes('cost') || NON_RATE_PRICING_KEYS.has(key);
}

export function getDescriptor(base: string): CostKeyDescriptor | undefined {
  return BY_BASE.get(base);
}

export const SERVICE_TIER_SUFFIX: Readonly<Record<string, SvcTier | undefined>> = {
  standard: undefined,
  batch: 'batches',
  priority: 'priority',
  flex: 'flex',
};
