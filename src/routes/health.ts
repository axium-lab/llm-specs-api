/** Health and manual refresh. */

import { Router } from 'express';
import { config } from '../config.ts';
import { store } from '../data/store.ts';
import { problem } from '../lib/problem.ts';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  if (!store.ready) {
    return res.status(503).json({ status: 'starting', ready: false });
  }

  const snapshot = store.snapshot;
  const ageMs = Date.now() - new Date(snapshot.loadedAt).getTime();

  res.json({
    status: 'ok',
    ready: true,
    models: snapshot.models.length,
    dataset_age_ms: ageMs,
    last_refresh: {
      at: store.lastRefreshAt,
      status: store.lastRefreshStatus,
      error: store.lastError,
    },
  });
});

healthRouter.post('/admin/refresh', async (req, res) => {
  if (!config.adminToken) {
    return problem(res, 404, 'not-found', 'Manual refresh is not enabled.', {
      detail: 'Set ADMIN_TOKEN to enable this endpoint.',
    });
  }

  const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided !== config.adminToken) {
    return problem(res, 401, 'unauthorized', 'Invalid admin token.');
  }

  const outcome = await store.refresh();
  if (outcome.status === 'failed') {
    return problem(res, 502, 'upstream-error', 'Could not refresh from upstream.', {
      detail: outcome.error,
      note: 'The previous in-memory copy is kept.',
    });
  }

  res.json(outcome);
});
