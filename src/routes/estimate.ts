/** `POST /v1/estimate` — cost calculation for a single call. */

import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.ts';
import { problem } from '../lib/problem.ts';
import { looksLikePricingKey } from '../pricing/catalog.ts';
import { estimate } from '../pricing/estimate.ts';
import type { ModelEntry } from '../types.ts';

export const estimateRouter: Router = Router();

const nonNegative = z.number().finite().nonnegative();

const usageSchema = z
  .object({
    input_tokens: nonNegative.optional(),
    output_tokens: nonNegative.optional(),
    reasoning_tokens: nonNegative.optional(),
    cache_read_tokens: nonNegative.optional(),
    cache_creation_tokens: nonNegative.optional(),
    cache_creation_tokens_by_ttl: z
      .object({ '5m': nonNegative.optional(), '1h': nonNegative.optional() })
      .optional(),

    input_audio_tokens: nonNegative.optional(),
    output_audio_tokens: nonNegative.optional(),
    cache_read_audio_tokens: nonNegative.optional(),
    cache_creation_audio_tokens: nonNegative.optional(),
    input_image_tokens: nonNegative.optional(),
    output_image_tokens: nonNegative.optional(),
    output_video_tokens: nonNegative.optional(),

    input_characters: nonNegative.optional(),
    output_characters: nonNegative.optional(),
    audio_seconds: nonNegative.optional(),
    output_audio_seconds: nonNegative.optional(),
    video_seconds: nonNegative.optional(),
    output_video_seconds: nonNegative.optional(),
    input_images: nonNegative.optional(),
    output_images: nonNegative.optional(),
    image_dimensions: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        count: z.number().int().positive().optional(),
      })
      .optional(),
    input_pixels: nonNegative.optional(),
    output_pixels: nonNegative.optional(),
    pages: nonNegative.optional(),
    annotated_pages: nonNegative.optional(),
    requests: nonNegative.optional(),
    queries: nonNegative.optional(),
    search_results: nonNegative.optional(),
    code_interpreter_sessions: nonNegative.optional(),
    web_search: z
      .object({
        queries: nonNegative,
        context_size: z.enum(['low', 'medium', 'high']).optional(),
      })
      .optional(),
  })
  .strict();

const requestSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1).optional(),
    usage: usageSchema,
    service_tier: z.enum(['standard', 'batch', 'priority', 'flex']).default('standard'),
    region_processing: z.enum(['global', 'eu', 'us']).default('global'),
    options: z
      .object({
        tier_policy: z.enum(['flag', 'marginal']).default('flag'),
        threshold_basis: z.enum(['input_only', 'input_plus_cache']).default('input_plus_cache'),
        cache_tokens_included_in_input: z.boolean().default(false),
        limit_policy: z.enum(['error', 'warn', 'ignore']).default('warn'),
        transcription_billing: z.enum(['input_only', 'both']).default('both'),
        round_to: z.number().int().min(0).max(20).default(10),
      })
      .strict()
      .default({}),
  })
  .strict();

function resolveModel(id: string, provider?: string): { model?: ModelEntry; ambiguous?: ModelEntry[] } {
  const { byId, byLowerId } = store.snapshot;

  const exact = byId.get(id);
  if (exact && (!provider || exact.provider === provider)) return { model: exact };

  const candidates = (byLowerId.get(id.toLowerCase()) ?? []).filter(
    (m) => !provider || m.provider === provider,
  );
  if (candidates.length === 0) return {};
  if (candidates.length > 1) return { ambiguous: candidates };
  return { model: candidates[0] };
}

/** A model with no pricing key at all cannot be billed: there are 97 of them in the dataset. */
function hasAnyPricing(model: ModelEntry): boolean {
  return Object.keys(model).some(looksLikePricingKey);
}

estimateRouter.post('/estimate', (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return problem(res, 400, 'invalid-request', 'The request is not valid.', {
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const body = parsed.data;
  const { model, ambiguous } = resolveModel(body.model, body.provider);

  if (ambiguous) {
    return problem(res, 409, 'ambiguous-model', 'The identifier is ambiguous.', {
      detail: 'Pass "provider" to disambiguate.',
      candidates: ambiguous.map((m) => ({ id: m.id, provider: m.provider })),
    });
  }

  if (!model) {
    return problem(res, 404, 'model-not-found', 'Model not found.', {
      detail: `There is no "${body.model}" entry in the dataset.`,
    });
  }

  if (!hasAnyPricing(model)) {
    return problem(res, 422, 'model-not-priced', 'The model exists but carries no pricing data.', {
      detail: 'The dataset publishes no rate for this entry.',
      model: { id: model.id, provider: model.provider, mode: model.mode ?? null },
    });
  }

  const usage = body.usage;
  if ((usage.reasoning_tokens ?? 0) > (usage.output_tokens ?? 0)) {
    return problem(res, 400, 'invalid-request', 'reasoning_tokens cannot exceed output_tokens.', {
      detail: 'reasoning_tokens is a subset of output_tokens.',
    });
  }

  const result = estimate({
    model,
    usage,
    serviceTier: body.service_tier,
    regionProcessing: body.region_processing,
    options: body.options,
  });

  if (body.options.limit_policy === 'error') {
    const breach = result.warnings.find(
      (w) => w.code === 'EXCEEDS_MAX_INPUT_TOKENS' || w.code === 'EXCEEDS_MAX_OUTPUT_TOKENS',
    );
    if (breach) {
      return problem(res, 422, 'limits-exceeded', 'The limits declared by the model are exceeded.', {
        detail: breach.message,
        ...breach.detail,
      });
    }
  }

  const snapshot = store.snapshot;
  res.json({
    model: {
      requested: body.model,
      resolved_key: model.id,
      provider: model.provider,
      mode: model.mode ?? null,
    },
    dataset: { sha256: snapshot.sha256 ?? null, loaded_at: snapshot.loadedAt },
    ...result,
  });
});
