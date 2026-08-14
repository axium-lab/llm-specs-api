/**
 * Cost calculation engine.
 *
 * Everything accumulates in Decimal, never in `number`. The dataset carries floating point noise
 * already serialized into the JSON literal itself (e.g. `1.2999000000000001e-07`) and rates as
 * small as 1.3e-10; summing in float drifts visibly across aggregates.
 *
 * Hard rule: a missing rate is NEVER replaced by 0. 249 models legitimately declare
 * `output_cost_per_token: 0.0`, so "free" (present and 0) has to stay distinguishable from
 * "unknown" (absent -> `unpriced` entry).
 */

import Decimal from 'decimal.js';
import type {
  CostLine,
  CurrencyCode,
  EstimateOptions,
  EstimateWarning,
  ModelEntry,
  MoneyTotal,
  ServiceTier,
  UnpricedItem,
  Usage,
} from '../types.ts';
import { getDescriptor } from './catalog.ts';
import {
  type ResolveContext,
  allThresholds,
  resolveWithSemanticFallback,
} from './resolve.ts';

Decimal.set({ precision: 40 });

/** Above this, a "per token" price implies >$500/MTok: almost always an upstream bug. */
const SUSPICIOUS_PER_TOKEN_RATE = 5e-4;

/** Models whose sky-high price is real and must not be flagged. */
const SUSPICIOUS_RATE_ALLOWLIST = [/^o1-pro/, /^openai\/o1-pro/, /o1-pro$/];

export interface EstimateInput {
  model: ModelEntry;
  usage: Usage;
  serviceTier: ServiceTier;
  regionProcessing: 'global' | 'eu' | 'us';
  options: Required<Pick<EstimateOptions, 'tier_policy' | 'threshold_basis' | 'cache_tokens_included_in_input' | 'limit_policy' | 'transcription_billing' | 'round_to'>>;
}

export interface EstimateResult {
  totals: Record<string, MoneyTotal>;
  lines: CostLine[];
  subtotals: Record<string, string>;
  resolution: {
    service_tier_requested: ServiceTier;
    service_tier_applied: ServiceTier;
    tier_policy: 'flag' | 'marginal';
    threshold_basis: 'input_only' | 'input_plus_cache';
    threshold_tokens_considered: number;
    context_tier_applied: string | null;
    context_tier_thresholds_available: number[];
    pricing_mechanism: 'flat_keys' | 'tiered_pricing';
    rate_keys_used: string[];
  };
  warnings: EstimateWarning[];
  unpriced: UnpricedItem[];
}

/** One usage component: which `usage` field is billed with which base key. */
interface Component {
  id: string;
  usageField: keyof Usage | string;
  quantity: number;
  base: string;
  ttl?: 'above_1hr';
  note?: string;
}

export function estimate(input: EstimateInput): EstimateResult {
  const { model, usage, serviceTier, options } = input;
  const warnings: EstimateWarning[] = [];
  const unpriced: UnpricedItem[] = [];
  const lines: CostLine[] = [];

  const thresholdTokens = computeThresholdTokens(usage, options);
  const ctx: ResolveContext = {
    thresholdTokens,
    serviceTier,
    tierPolicy: options.tier_policy,
  };

  const components = buildComponents(usage, options, warnings);

  let appliedThreshold: number | null = null;
  let serviceTierApplied: ServiceTier = serviceTier;

  for (const component of components) {
    if (component.quantity <= 0) continue;

    const descriptor = getDescriptor(component.base);
    if (!descriptor) continue;

    const resolved = resolveWithSemanticFallback(model, component.base, {
      ...ctx,
      ttl: component.ttl,
    });

    if (!resolved) {
      unpriced.push({
        usage_field: String(component.usageField),
        quantity: component.quantity,
        reason: 'NO_RATE_KEY',
        candidate_keys_checked: [component.base],
      });
      continue;
    }

    const { rate, fellBackFrom } = resolved;
    if (rate.appliedThreshold !== null) appliedThreshold = rate.appliedThreshold;

    if (fellBackFrom) {
      warnings.push({
        code: 'RATE_FALLBACK_APPLIED',
        message: `No rate for "${fellBackFrom}"; using "${rate.key}".`,
        field: String(component.usageField),
      });
    }
    if (rate.usedAlias) {
      warnings.push({
        code: 'ALIAS_KEY_USED',
        message: `Used the alias key "${rate.key}" (equivalent to ${component.base}).`,
        field: String(component.usageField),
      });
    }
    if (rate.degradations.includes('service_tier')) {
      serviceTierApplied = 'standard';
      warnings.push({
        code: 'SERVICE_TIER_NOT_PRICED',
        message: `The model has no "${serviceTier}" rate for ${component.base}; falling back to standard.`,
        field: String(component.usageField),
      });
    }
    if (rate.degradations.includes('context_tier')) {
      warnings.push({
        code: 'CONTEXT_TIER_NOT_PRICED',
        message: `No long-context rate for ${component.base}; using the base rate.`,
        field: String(component.usageField),
      });
    }

    const rateDecimal = new Decimal(rate.value);
    const amount = rateDecimal.times(component.quantity).dividedBy(descriptor.perUnits);

    if (descriptor.unit === 'token' && rate.value > SUSPICIOUS_PER_TOKEN_RATE && !isAllowlisted(model.id)) {
      warnings.push({
        code: 'SUSPICIOUS_RATE_MAGNITUDE',
        message: `Rate ${rate.key}=${rate.value} implies $${rateDecimal.times(1e6).toString()}/MTok. Likely an upstream dataset error.`,
        field: rate.key,
        detail: { rate: rate.value, per_million_tokens: rateDecimal.times(1e6).toString() },
      });
    }

    const notes: string[] = [];
    if (component.note) notes.push(component.note);
    if (rate.appliedThreshold !== null) {
      notes.push(
        `Long-context rate: ${thresholdTokens} > ${rate.appliedThreshold} tokens (flag tier).`,
      );
    }

    lines.push({
      id: component.id,
      label: descriptor.label,
      category: descriptor.category,
      currency: descriptor.currency,
      quantity: component.quantity,
      unit: descriptor.unit,
      rate: rateDecimal.toString(),
      rate_key: rate.key,
      rate_per_units: descriptor.perUnits,
      amount: amount.toString(),
      ...(notes.length > 0 ? { notes } : {}),
    });
  }

  applyRegionalSurcharge(input, lines, warnings);
  addModelWarnings(model, usage, thresholdTokens, options, warnings);

  const totals = computeTotals(lines, options.round_to);
  if (Object.keys(totals).length > 1) {
    warnings.push({
      code: 'MIXED_CURRENCY_TOTALS',
      message: 'The model has rates in more than one currency (e.g. Databricks DBU); the totals are not summable.',
    });
  }

  return {
    totals,
    lines,
    subtotals: computeSubtotals(lines),
    resolution: {
      service_tier_requested: serviceTier,
      service_tier_applied: serviceTierApplied,
      tier_policy: options.tier_policy,
      threshold_basis: options.threshold_basis,
      threshold_tokens_considered: thresholdTokens,
      context_tier_applied: appliedThreshold !== null ? `above_${appliedThreshold / 1000}k_tokens` : null,
      context_tier_thresholds_available: allThresholds(model),
      pricing_mechanism: 'flat_keys',
      rate_keys_used: [...new Set(lines.map((l) => l.rate_key))],
    },
    warnings,
    unpriced,
  };
}

function isAllowlisted(id: string): boolean {
  return SUSPICIOUS_RATE_ALLOWLIST.some((re) => re.test(id));
}

/**
 * Which tokens count towards the long-context threshold.
 *
 * By default `input + cache_read + cache_creation`: Anthropic measures the threshold against the
 * total size of the input context, cached parts included. Configurable because LiteLLM uses the
 * `prompt_tokens` the provider returns, which on Anthropic does NOT include cached tokens.
 */
function computeThresholdTokens(usage: Usage, options: EstimateInput['options']): number {
  const input = usage.input_tokens ?? 0;
  if (options.threshold_basis === 'input_only') return input;

  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheCreation = totalCacheCreation(usage);
  // If the client already folded the cached tokens into input_tokens, do not count them twice.
  return options.cache_tokens_included_in_input ? input : input + cacheRead + cacheCreation;
}

function totalCacheCreation(usage: Usage): number {
  const byTtl = usage.cache_creation_tokens_by_ttl ?? {};
  return (usage.cache_creation_tokens ?? 0) + (byTtl['5m'] ?? 0) + (byTtl['1h'] ?? 0);
}

function buildComponents(
  usage: Usage,
  options: EstimateInput['options'],
  warnings: EstimateWarning[],
): Component[] {
  const components: Component[] = [];

  // `reasoning_tokens` is a SUBSET of `output_tokens`: subtract it so it is not billed twice.
  const reasoning = usage.reasoning_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const plainOutput = Math.max(0, output - reasoning);

  const inputTokens = options.cache_tokens_included_in_input
    ? Math.max(0, (usage.input_tokens ?? 0) - (usage.cache_read_tokens ?? 0))
    : (usage.input_tokens ?? 0);

  push(components, 'input.text', 'input_tokens', inputTokens, 'input_cost_per_token');
  push(components, 'output.text', 'output_tokens', plainOutput, 'output_cost_per_token');
  push(components, 'output.reasoning', 'reasoning_tokens', reasoning, 'output_cost_per_reasoning_token');
  push(components, 'cache_read.text', 'cache_read_tokens', usage.cache_read_tokens ?? 0, 'cache_read_input_token_cost');

  // Cache writes: the 1h TTL has its own rate (`_above_1hr`), which is NOT a threshold.
  const byTtl = usage.cache_creation_tokens_by_ttl ?? {};
  const write5m = (usage.cache_creation_tokens ?? 0) + (byTtl['5m'] ?? 0);
  push(components, 'cache_write.5m', 'cache_creation_tokens', write5m, 'cache_creation_input_token_cost');
  if ((byTtl['1h'] ?? 0) > 0) {
    components.push({
      id: 'cache_write.1h',
      usageField: 'cache_creation_tokens_by_ttl.1h',
      quantity: byTtl['1h']!,
      base: 'cache_creation_input_token_cost',
      ttl: 'above_1hr',
      note: 'Cache write with a 1 hour TTL.',
    });
  }

  // Multimodal, per token
  push(components, 'input.audio_tokens', 'input_audio_tokens', usage.input_audio_tokens ?? 0, 'input_cost_per_audio_token');
  push(components, 'output.audio_tokens', 'output_audio_tokens', usage.output_audio_tokens ?? 0, 'output_cost_per_audio_token');
  push(components, 'cache_read.audio', 'cache_read_audio_tokens', usage.cache_read_audio_tokens ?? 0, 'cache_read_input_audio_token_cost');
  push(components, 'cache_write.audio', 'cache_creation_audio_tokens', usage.cache_creation_audio_tokens ?? 0, 'cache_creation_input_audio_token_cost');
  push(components, 'input.image_tokens', 'input_image_tokens', usage.input_image_tokens ?? 0, 'input_cost_per_image_token');
  push(components, 'output.image_tokens', 'output_image_tokens', usage.output_image_tokens ?? 0, 'output_cost_per_image_token');
  push(components, 'output.video_tokens', 'output_video_tokens', usage.output_video_tokens ?? 0, 'output_cost_per_video_token');

  // Non-token units
  push(components, 'input.characters', 'input_characters', usage.input_characters ?? 0, 'input_cost_per_character');
  push(components, 'output.characters', 'output_characters', usage.output_characters ?? 0, 'output_cost_per_character');

  const pixels = usage.input_pixels ?? pixelsFromDimensions(usage);
  push(components, 'input.pixels', 'input_pixels', pixels, 'input_cost_per_pixel');
  push(components, 'output.pixels', 'output_pixels', usage.output_pixels ?? 0, 'output_cost_per_pixel');
  push(components, 'input.images', 'input_images', usage.input_images ?? 0, 'input_cost_per_image');
  push(components, 'output.images', 'output_images', usage.output_images ?? 0, 'output_cost_per_image');

  // Transcription: whisper-1 declares input AND output per second. assemblyai spelling out
  // `output_cost_per_second: 0.0` suggests both are meant to be added together.
  const audioSeconds = usage.audio_seconds ?? 0;
  push(components, 'input.audio_seconds', 'audio_seconds', audioSeconds, 'input_cost_per_second');
  if (options.transcription_billing === 'both' && audioSeconds > 0) {
    components.push({
      id: 'output.audio_seconds',
      usageField: 'audio_seconds',
      quantity: usage.output_audio_seconds ?? audioSeconds,
      base: 'output_cost_per_second',
      note: 'The model also declares a per-second output cost; it is billed alongside the input one.',
    });
  } else if (usage.output_audio_seconds) {
    push(components, 'output.audio_seconds', 'output_audio_seconds', usage.output_audio_seconds, 'output_cost_per_second');
  }

  push(components, 'input.video_seconds', 'video_seconds', usage.video_seconds ?? 0, 'input_cost_per_video_per_second');
  push(components, 'output.video_seconds', 'output_video_seconds', usage.output_video_seconds ?? 0, 'output_cost_per_video_per_second');
  push(components, 'other.pages', 'pages', usage.pages ?? 0, 'ocr_cost_per_page');
  push(components, 'other.annotated_pages', 'annotated_pages', usage.annotated_pages ?? 0, 'annotation_cost_per_page');
  push(components, 'input.requests', 'requests', usage.requests ?? 0, 'input_cost_per_request');
  push(components, 'input.queries', 'queries', usage.queries ?? 0, 'input_cost_per_query');
  push(components, 'other.code_interpreter', 'code_interpreter_sessions', usage.code_interpreter_sessions ?? 0, 'code_interpreter_cost_per_session');

  if (usage.reasoning_tokens && usage.reasoning_tokens > output) {
    warnings.push({
      code: 'RATE_FALLBACK_APPLIED',
      message: 'reasoning_tokens exceeds output_tokens; only the declared output is billed.',
      field: 'reasoning_tokens',
    });
  }

  return components;
}

function pixelsFromDimensions(usage: Usage): number {
  const dims = usage.image_dimensions;
  if (!dims) return 0;
  return dims.width * dims.height * (dims.count ?? 1);
}

function push(
  components: Component[],
  id: string,
  usageField: string,
  quantity: number,
  base: string,
): void {
  if (quantity > 0) components.push({ id, usageField, quantity, base });
}

/**
 * The regional uplift is applied as a separate surcharge line over the subtotal, not by
 * multiplying every rate: that keeps the breakdown auditable against the published table.
 */
function applyRegionalSurcharge(
  input: EstimateInput,
  lines: CostLine[],
  warnings: EstimateWarning[],
): void {
  const { model, regionProcessing } = input;
  if (regionProcessing === 'global') return;

  const multiplier = model[`regional_processing_uplift_multiplier_${regionProcessing}`];
  if (typeof multiplier !== 'number' || multiplier === 1) return;

  const subtotalUsd = lines
    .filter((l) => l.currency === 'USD')
    .reduce((acc, l) => acc.plus(l.amount), new Decimal(0));

  const surcharge = subtotalUsd.times(new Decimal(multiplier).minus(1));
  if (surcharge.isZero()) return;

  lines.push({
    id: `surcharge.region_${regionProcessing}`,
    label: `Regional processing surcharge (${regionProcessing.toUpperCase()})`,
    category: 'surcharge',
    currency: 'USD',
    quantity: 1,
    unit: 'request',
    rate: new Decimal(multiplier).minus(1).toString(),
    rate_key: `regional_processing_uplift_multiplier_${regionProcessing}`,
    rate_per_units: 1,
    amount: surcharge.toString(),
    notes: [`Multiplier ${multiplier} applied over the USD subtotal.`],
  });
  warnings.push({
    code: 'RATE_FALLBACK_APPLIED',
    message: `Applied the ${regionProcessing} regional uplift (×${multiplier}).`,
  });
}

function addModelWarnings(
  model: ModelEntry,
  usage: Usage,
  thresholdTokens: number,
  options: EstimateInput['options'],
  warnings: EstimateWarning[],
): void {
  if (options.limit_policy !== 'ignore') {
    const maxInput = model.max_input_tokens;
    if (typeof maxInput === 'number' && thresholdTokens > maxInput) {
      warnings.push({
        code: 'EXCEEDS_MAX_INPUT_TOKENS',
        message: `${thresholdTokens} input tokens exceed max_input_tokens=${maxInput}.`,
        detail: { max_input_tokens: maxInput, provided: thresholdTokens },
      });
    }
    const maxOutput = model.max_output_tokens;
    const output = usage.output_tokens ?? 0;
    if (typeof maxOutput === 'number' && output > maxOutput) {
      warnings.push({
        code: 'EXCEEDS_MAX_OUTPUT_TOKENS',
        message: `${output} output tokens exceed max_output_tokens=${maxOutput}.`,
        detail: { max_output_tokens: maxOutput, provided: output },
      });
    }
  }

  const minCache = model.prompt_cache_min_tokens;
  const cacheWrite = totalCacheCreation(usage);
  if (typeof minCache === 'number' && cacheWrite > 0 && cacheWrite < minCache) {
    warnings.push({
      code: 'CACHE_BELOW_MIN_TOKENS',
      message: `The cache write (${cacheWrite}) is below prompt_cache_min_tokens=${minCache}: the provider would not have cached it.`,
      detail: { prompt_cache_min_tokens: minCache, provided: cacheWrite },
    });
  }

  if (typeof model.deprecation_date === 'string') {
    const date = new Date(model.deprecation_date);
    if (!Number.isNaN(date.getTime()) && date.getTime() < Date.now()) {
      warnings.push({
        code: 'DEPRECATED_MODEL',
        message: `The model has been marked deprecated since ${model.deprecation_date}.`,
        detail: { deprecation_date: model.deprecation_date },
      });
    }
  }
}

function computeTotals(lines: CostLine[], roundTo: number): Record<string, MoneyTotal> {
  const byCurrency = new Map<CurrencyCode, Decimal>();
  for (const line of lines) {
    const current = byCurrency.get(line.currency) ?? new Decimal(0);
    byCurrency.set(line.currency, current.plus(line.amount));
  }

  const totals: Record<string, MoneyTotal> = {};
  for (const [currency, amount] of byCurrency) {
    totals[currency] = {
      exact: amount.toString(),
      rounded: amount.toFixed(roundTo),
      decimals: roundTo,
    };
  }
  // With no priced lines we still return a USD total, so the response shape stays stable.
  if (Object.keys(totals).length === 0) {
    totals['USD'] = { exact: '0', rounded: new Decimal(0).toFixed(roundTo), decimals: roundTo };
  }
  return totals;
}

function computeSubtotals(lines: CostLine[]): Record<string, string> {
  const byCategory = new Map<string, Decimal>();
  for (const line of lines) {
    const current = byCategory.get(line.category) ?? new Decimal(0);
    byCategory.set(line.category, current.plus(line.amount));
  }
  return Object.fromEntries([...byCategory].map(([k, v]) => [k, v.toString()]));
}
