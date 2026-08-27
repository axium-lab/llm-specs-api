/** Filtering, sorting, pagination and projection for `GET /v1/models`. */

import { config } from '../config.ts';
import type { ModelEntry } from '../types.ts';

export interface ListQuery {
  provider?: string;
  mode?: string;
  q?: string;
  min_input_tokens?: string;
  max_input_cost?: string;
  sort?: string;
  fields?: string;
  limit?: string;
  offset?: string;
  [key: string]: string | undefined;
}

export interface ListResult {
  total: number;
  limit: number;
  offset: number;
  data: Record<string, unknown>[];
}

export class BadQueryError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumber(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadQueryError(`"${field}" must be a number`, field);
  return n;
}

function parseBool(value: string, field: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new BadQueryError(`"${field}" must be true or false`, field);
}

export function listModels(all: ModelEntry[], query: ListQuery): ListResult {
  let result = all;

  if (query.provider) {
    const wanted = new Set(splitList(query.provider).map((s) => s.toLowerCase()));
    result = result.filter((m) => wanted.has(m.provider.toLowerCase()));
  }

  if (query.mode) {
    const wanted = new Set(splitList(query.mode).map((s) => s.toLowerCase()));
    result = result.filter((m) => typeof m.mode === 'string' && wanted.has(m.mode.toLowerCase()));
  }

  if (query.q) {
    const needle = query.q.toLowerCase();
    result = result.filter((m) => m.id.toLowerCase().includes(needle));
  }

  if (query.min_input_tokens !== undefined) {
    const min = parseNumber(query.min_input_tokens, 'min_input_tokens');
    result = result.filter(
      (m) => typeof m.max_input_tokens === 'number' && m.max_input_tokens >= min,
    );
  }

  if (query.max_input_cost !== undefined) {
    const max = parseNumber(query.max_input_cost, 'max_input_cost');
    result = result.filter((m) => {
      const cost = m['input_cost_per_token'];
      return typeof cost === 'number' && cost <= max;
    });
  }

  // Generic filters over any `supports_*` key of the dataset.
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('supports_') || value === undefined) continue;
    const wanted = parseBool(value, key);
    result = result.filter((m) => (m[key] === true) === wanted);
  }

  const total = result.length;

  if (query.sort) {
    result = sortModels(result, query.sort);
  }

  const limit = clampLimit(query.limit);
  const offset = query.offset === undefined ? 0 : Math.max(0, parseNumber(query.offset, 'offset'));
  const page = result.slice(offset, offset + limit);

  const fields = query.fields ? splitList(query.fields) : null;
  const data = fields ? page.map((m) => project(m, fields)) : page.map((m) => ({ ...m }));

  return { total, limit, offset, data };
}

function clampLimit(raw?: string): number {
  if (raw === undefined) return config.defaultLimit;
  const n = parseNumber(raw, 'limit');
  if (n < 1) throw new BadQueryError('"limit" must be >= 1', 'limit');
  return Math.min(n, config.maxLimit);
}

function sortModels(models: ModelEntry[], sort: string): ModelEntry[] {
  const [field, direction = 'asc'] = sort.split(':');
  if (!field) throw new BadQueryError('"sort" must look like field[:asc|desc]', 'sort');
  if (direction !== 'asc' && direction !== 'desc') {
    throw new BadQueryError('The "sort" direction must be asc or desc', 'sort');
  }
  const sign = direction === 'asc' ? 1 : -1;

  // Models that do not declare the field always go last, whatever the direction:
  // "no value" is not the same as "the lowest value".
  return [...models].sort((a, b) => {
    const av = field === 'id' ? a.id : a[field];
    const bv = field === 'id' ? b.id : b[field];
    const aMissing = av === undefined || av === null;
    const bMissing = bv === undefined || bv === null;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}

function project(model: ModelEntry, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in model) out[field] = model[field];
  }
  return out;
}
