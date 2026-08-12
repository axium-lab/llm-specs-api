import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { store } from './data/store.ts';
import { problem } from './lib/problem.ts';
import { facetsRouter } from './routes/facets.ts';
import { healthRouter } from './routes/health.ts';
import { modelsRouter } from './routes/models.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use(healthRouter);

  // Everything that queries the dataset needs the cache to be loaded.
  app.use('/v1', (_req, res, next) => {
    if (!store.ready) {
      return problem(res, 503, 'not-ready', 'The dataset is still loading.');
    }
    next();
  });

  app.use('/v1', modelsRouter);
  app.use('/v1', facetsRouter);

  app.use((req, res) => {
    problem(res, 404, 'not-found', 'Route not found.', { path: req.path });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[error]', message);
    problem(res, 500, 'internal-error', 'Internal error.', { detail: message });
  });

  return app;
}
