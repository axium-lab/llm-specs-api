/** Dataset facets and metadata. */

import { Router } from 'express';
import { config } from '../config.ts';
import { store } from '../data/store.ts';
import { looksLikePricingKey } from '../pricing/catalog.ts';

export const facetsRouter: Router = Router();

function counts(map: Map<string, unknown[]>): { name: string; models: number }[] {
  return [...map.entries()]
    .map(([name, list]) => ({ name, models: list.length }))
    .sort((a, b) => b.models - a.models || a.name.localeCompare(b.name));
}

facetsRouter.get('/providers', (_req, res) => {
  const data = counts(store.snapshot.byProvider);
  res.json({ total: data.length, data });
});

facetsRouter.get('/modes', (_req, res) => {
  const snapshot = store.snapshot;
  const data = counts(snapshot.byMode);
  const withoutMode = snapshot.models.filter((m) => typeof m.mode !== 'string').length;
  res.json({ total: data.length, models_without_mode: withoutMode, data });
});

facetsRouter.get('/attributes', (_req, res) => {
  const data = [...store.snapshot.attributeCounts.entries()]
    .map(([name, models]) => ({ name, models, pricing: looksLikePricingKey(name) }))
    .sort((a, b) => b.models - a.models || a.name.localeCompare(b.name));
  res.json({ total: data.length, pricing_keys: data.filter((d) => d.pricing).length, data });
});

facetsRouter.get('/meta', (_req, res) => {
  const snapshot = store.snapshot;
  res.json({
    models: snapshot.models.length,
    providers: snapshot.byProvider.size,
    modes: snapshot.byMode.size,
    attributes: snapshot.attributeCounts.size,
    dataset: {
      source: snapshot.source,
      upstream_url: config.upstreamUrl,
      etag: snapshot.etag ?? null,
      sha256: snapshot.sha256 ?? null,
      loaded_at: snapshot.loadedAt,
      startup_error: store.lastError,
    },
  });
});
