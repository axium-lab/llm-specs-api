/** Liveness and readiness. */

import { Router } from 'express';
import { store } from '../data/store.ts';

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
    dataset: {
      source: snapshot.source,
      etag: snapshot.etag ?? null,
      sha256: snapshot.sha256 ?? null,
      loaded_at: snapshot.loadedAt,
    },
    // Set when upstream could not be reached at boot and the local copy carried the service.
    startup_error: store.lastError,
  });
});
