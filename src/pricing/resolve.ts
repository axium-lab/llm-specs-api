/**
 * Rate resolution: given a base key and the request context, decides WHICH concrete dataset key
 * applies.
 *
 * Core rule — the context tier is a FLAG, not marginal: if the prompt crosses the threshold, the
 * WHOLE request (input, output and cache) is billed at the premium rate. Evidence:
 *
 *  1. The dataset defines `output_cost_per_token_above_200k_tokens` on 60 models. An *output*
 *     price conditioned on an *input* threshold only makes sense as a flag.
 *  2. LiteLLM (`_get_token_base_cost`) picks ONE rate by comparing `prompt_tokens > threshold`
 *     and multiplies the total by it; it does not accumulate per band.
 *  3. Of the 117 (base, above) input pairs, 116 have a ratio of exactly 2.0.
 *  4. Anthropic, Google and OpenAI document the same scheme.
 */

import type { ModelEntry, ServiceTier } from '../types.ts';
import {
  type CacheTtlAxis,
  COST_KEY_ALIASES,
  type SvcTier,
  SERVICE_TIER_SUFFIX,
  buildCostKey,
  parseCostKey,
} from './catalog.ts';

export interface ResolveContext {
  /** Tokens counting towards the long-context threshold. */
  thresholdTokens: number;
  serviceTier: ServiceTier;
  ttl?: CacheTtlAxis;
  tierPolicy: 'flag' | 'marginal';
}

export interface ResolvedRate {
  key: string;
  value: number;
  /** Degradation steps applied, so the client can be warned. */
  degradations: string[];
  usedAlias: boolean;
  /** Threshold actually applied, or null when the base rate was used. */
  appliedThreshold: number | null;
}

function readRate(model: ModelEntry, key: string): number | undefined {
  const value = model[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `_above_Nk_tokens` thresholds this model declares for a given base, highest first. */
export function thresholdsFor(model: ModelEntry, base: string): number[] {
  const found = new Set<number>();
  for (const key of Object.keys(model)) {
    const parsed = parseCostKey(key);
    if (parsed?.descriptor.base === base && parsed.ctxThreshold !== undefined) {
      found.add(parsed.ctxThreshold);
    }
  }
  return [...found].sort((a, b) => b - a);
}

/** Every threshold declared by the model, whatever the base. */
export function allThresholds(model: ModelEntry): number[] {
  const found = new Set<number>();
  for (const key of Object.keys(model)) {
    const parsed = parseCostKey(key);
    if (parsed?.ctxThreshold !== undefined) found.add(parsed.ctxThreshold);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Picks the applicable threshold: the highest one the prompt crosses. `null` when it crosses
 * none, or when the policy is marginal (where bands are handled separately).
 */
export function pickThreshold(model: ModelEntry, base: string, ctx: ResolveContext): number | null {
  if (ctx.tierPolicy === 'marginal') return null;
  for (const threshold of thresholdsFor(model, base)) {
    if (ctx.thresholdTokens > threshold) return threshold;
  }
  return null;
}

/**
 * Degradation cascade: the most specific key is tried first, then axes are dropped one by one.
 * Every lost step is recorded so the matching warning can be emitted.
 */
export function resolveRate(
  model: ModelEntry,
  base: string,
  ctx: ResolveContext,
): ResolvedRate | null {
  const svcTier: SvcTier | undefined = SERVICE_TIER_SUFFIX[ctx.serviceTier];
  const threshold = pickThreshold(model, base, ctx);
  const ttl = ctx.ttl;

  interface Candidate {
    ttl?: CacheTtlAxis;
    ctxThreshold?: number;
    svcTier?: SvcTier;
    lost?: string;
  }

  // Order: keeping the TTL comes first (it changes the product being billed), then the context
  // tier (it changes the price ~2x), and the service tier last.
  const candidates: Candidate[] = [
    { ttl, ctxThreshold: threshold ?? undefined, svcTier },
    { ttl, ctxThreshold: threshold ?? undefined, lost: 'service_tier' },
    { ttl, svcTier, lost: 'context_tier' },
    { ttl, lost: 'service_tier+context_tier' },
    { ctxThreshold: threshold ?? undefined, svcTier, lost: 'ttl' },
    { ctxThreshold: threshold ?? undefined, lost: 'ttl+service_tier' },
    { svcTier, lost: 'ttl+context_tier' },
    { lost: 'ttl+context_tier+service_tier' },
  ];

  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = buildCostKey(base, {
      ttl: candidate.ttl,
      ctxThreshold: candidate.ctxThreshold,
      svcTier: candidate.svcTier,
    });
    if (seen.has(key)) continue;
    seen.add(key);

    const value = readRate(model, key);
    if (value === undefined) continue;

    // The axes this candidate dropped ARE the degradation: they describe the gap between what
    // was requested and the rate that actually exists in the dataset.
    return {
      key,
      value,
      degradations: candidate.lost ? candidate.lost.split('+') : [],
      usedAlias: false,
      appliedThreshold: candidate.ctxThreshold ?? null,
    };
  }

  const degradations: string[] = [];

  // Legacy alias: DeepSeek publishes the cache read under a different name.
  for (const [alias, canonical] of Object.entries(COST_KEY_ALIASES)) {
    if (canonical !== base) continue;
    const value = readRate(model, alias);
    if (value !== undefined) {
      return { key: alias, value, degradations, usedAlias: true, appliedThreshold: null };
    }
  }

  return null;
}

/**
 * Semantic fallbacks between different bases. An explicit table, never a heuristic.
 * `output_cost_per_reasoning_token` matches `output_cost_per_token` on 51 of the 57 models that
 * declare it, so the fallback is reasonable but ALWAYS emits a warning.
 */
export const SEMANTIC_FALLBACKS: Readonly<Record<string, string>> = {
  output_cost_per_reasoning_token: 'output_cost_per_token',
};

export function resolveWithSemanticFallback(
  model: ModelEntry,
  base: string,
  ctx: ResolveContext,
): { rate: ResolvedRate; fellBackFrom?: string } | null {
  const direct = resolveRate(model, base, ctx);
  if (direct) return { rate: direct };

  const fallbackBase = SEMANTIC_FALLBACKS[base];
  if (!fallbackBase) return null;

  const fallback = resolveRate(model, fallbackBase, ctx);
  return fallback ? { rate: fallback, fellBackFrom: base } : null;
}
