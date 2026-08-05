/**
 * Model routes.
 *
 * MIND the declaration order and the wildcard syntax: 81% of the dataset ids contain a `/`
 * (`bedrock/amazon.nova-canvas-v1:0`), so `:id` is useless here. Express 5 also requires the
 * wildcard to be named (`*splat`) and exposes the segments as an ARRAY.
 */

import { Router } from 'express';
import { store } from '../data/store.ts';
import { problem } from '../lib/problem.ts';
import type { ModelEntry } from '../types.ts';

export const modelsRouter: Router = Router();

function findById(id: string): { model?: ModelEntry; ambiguous?: ModelEntry[] } {
  const { byId, byLowerId } = store.snapshot;

  // Lookup is exact and case-sensitive: the dataset holds `together_ai/baai/...` and
  // `together_ai/BAAI/...` as distinct entries.
  const exact = byId.get(id);
  if (exact) return { model: exact };

  const candidates = byLowerId.get(id.toLowerCase());
  if (!candidates || candidates.length === 0) return {};
  if (candidates.length > 1) return { ambiguous: candidates };
  return { model: candidates[0] };
}

/**
 * Query-param escape hatch. Covers the single id ending in `/`
 * (`fireworks_ai/accounts/fireworks/models/`), unreachable by path because Express normalizes
 * the trailing slash away. MUST be declared before the wildcard, or the wildcard swallows it.
 */
modelsRouter.get('/models/by-id', (req, res) => {
  const id = req.query['id'];
  if (typeof id !== 'string' || id === '') {
    return problem(res, 400, 'invalid-query', 'Missing "id" parameter.', { field: 'id' });
  }
  return respondWithModel(res, id);
});

modelsRouter.get('/models/*splat', (req, res) => {
  const splat = (req.params as Record<string, unknown>)['splat'];
  const id = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
  return respondWithModel(res, id);
});

function respondWithModel(res: Parameters<typeof problem>[0], id: string) {
  const { model, ambiguous } = findById(id);

  if (ambiguous) {
    return problem(res, 409, 'ambiguous-model', 'The identifier is ambiguous except for case.', {
      detail: `"${id}" matches several dataset entries.`,
      candidates: ambiguous.map((m) => m.id),
    });
  }

  if (!model) {
    return problem(res, 404, 'model-not-found', 'Model not found.', {
      detail: `There is no "${id}" entry in the dataset.`,
    });
  }

  return res.json(model);
}
