/**
 * Model routes.
 *
 * MIND the declaration order and the wildcard syntax: 81% of the dataset ids contain a `/`
 * (`bedrock/amazon.nova-canvas-v1:0`), so `:id` is useless here. Express 5 also requires the
 * wildcard to be named (`*splat`) and exposes the segments as an ARRAY.
 */

import { Router } from 'express';
import { store } from '../data/store.ts';
import { BadQueryError, listModels } from '../lib/filter.ts';
import { problem } from '../lib/problem.ts';
import type { ModelEntry } from '../types.ts';

export const modelsRouter: Router = Router();

/**
 * Suggestions for a 404. Criteria are tried from most to least exact: full substring, suffix
 * after the last `/`, and finally trigram similarity — that last one is what rescues typos
 * (`claude-sonnet-9-9` -> `claude-sonnet-4-5`), where there is no common substring at all.
 */
function suggest(id: string, all: ModelEntry[]): string[] {
  const needle = id.toLowerCase();
  const tail = needle.split('/').pop() ?? needle;

  const bySubstring = all.filter((m) => m.id.toLowerCase().includes(tail)).map((m) => m.id);
  if (bySubstring.length > 0) return bySubstring.slice(0, 10);

  const bySuffix = all
    .filter((m) => (m.id.toLowerCase().split('/').pop() ?? '') === tail)
    .map((m) => m.id);
  if (bySuffix.length > 0) return bySuffix.slice(0, 10);

  const wanted = trigrams(tail);
  if (wanted.size === 0) return [];

  return all
    .map((m) => ({ id: m.id, score: similarity(wanted, trigrams(m.id.toLowerCase())) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => x.id);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard index between the two trigram sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

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

modelsRouter.get('/models', (req, res) => {
  try {
    const result = listModels(store.snapshot.models, req.query as Record<string, string | undefined>);
    res.json(result);
  } catch (error) {
    if (error instanceof BadQueryError) {
      return problem(res, 400, 'invalid-query', error.message, { field: error.field });
    }
    throw error;
  }
});

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
      suggestions: suggest(id, store.snapshot.models),
    });
  }

  return res.json(model);
}
