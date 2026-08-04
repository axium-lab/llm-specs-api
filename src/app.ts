import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { problem } from './lib/problem.ts';
import { healthRouter } from './routes/health.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use(healthRouter);

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
