/** Errors in RFC 9457 format (`application/problem+json`). */

import type { Response } from 'express';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
}

export function problem(res: Response, status: number, type: string, title: string, extra: Record<string, unknown> = {}): Response {
  const body: Problem = { type: `about:blank#${type}`, title, status, ...extra };
  return res.status(status).type('application/problem+json').json(body);
}
