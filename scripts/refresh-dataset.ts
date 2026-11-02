/**
 * Revalidates the vendored dataset against upstream and rewrites `data/` when it changed.
 *
 * This is what `.github/workflows/refresh-dataset.yml` runs every day. It reuses the exact boot
 * path of the service (`store.init()`): the persisted ETag drives a conditional request, a 304
 * leaves the files untouched, and only a genuinely newer upstream is downloaded, normalized and
 * written back together with its sidecar. The workflow then commits whatever `git diff` sees.
 *
 * The one difference from a boot: a failed revalidation is fatal here. The service degrades to
 * the local copy on purpose, but a scheduled job that silently keeps stale data is worse than
 * one that fails and shows up red in the Actions tab.
 */

import { store } from '../src/data/store.ts';

await store.init();

if (store.lastError) {
  console.error(`Upstream revalidation failed: ${store.lastError}`);
  process.exit(1);
}

const { source, sha256, models } = store.snapshot;
console.log(
  source === 'upstream'
    ? `Dataset updated from upstream: ${models.length} models, sha256 ${sha256}`
    : `Dataset already current: ${models.length} models, sha256 ${sha256}`,
);
