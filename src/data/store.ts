/**
 * In-memory cache of the dataset, with prebuilt indexes and an atomic swap.
 *
 * There is no database: this is read-only data that changes rarely, and on Cloud Run every
 * instance is ephemeral. A DB would add latency and one more service without buying anything.
 *
 * The source of truth is the file on disk (see `local.ts`). Every instance revalidates it
 * against upstream once, at boot, and serves whatever it has from memory afterwards.
 */

import { config } from '../config.ts';
import { type ModelEntry, isModelEntry } from '../types.ts';
import { fetchDataset } from './fetcher.ts';
import { readLocalDataset, writeLocalDataset } from './local.ts';

export type DatasetSource = 'local' | 'upstream';

export interface Snapshot {
  models: ModelEntry[];
  byId: Map<string, ModelEntry>;
  /** Lowercase secondary index. One lowercase key can map to several real keys. */
  byLowerId: Map<string, ModelEntry[]>;
  byProvider: Map<string, ModelEntry[]>;
  byMode: Map<string, ModelEntry[]>;
  attributeCounts: Map<string, number>;
  /** Where the bytes in this snapshot came from on this boot. */
  source: DatasetSource;
  etag?: string;
  sha256?: string;
  loadedAt: string;
}

function buildSnapshot(
  json: string,
  source: DatasetSource = 'local',
  etag?: string,
  sha256?: string,
): Snapshot {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  const models: ModelEntry[] = [];
  const byId = new Map<string, ModelEntry>();
  const byLowerId = new Map<string, ModelEntry[]>();
  const byProvider = new Map<string, ModelEntry[]>();
  const byMode = new Map<string, ModelEntry[]>();
  const attributeCounts = new Map<string, number>();

  for (const [key, value] of Object.entries(parsed)) {
    if (!isModelEntry(key, value)) continue;

    const model: ModelEntry = { ...value, id: key };
    models.push(model);
    byId.set(key, model);

    const lower = key.toLowerCase();
    const bucket = byLowerId.get(lower);
    if (bucket) bucket.push(model);
    else byLowerId.set(lower, [model]);

    push(byProvider, model.litellm_provider, model);
    if (typeof model.mode === 'string') push(byMode, model.mode, model);

    for (const attr of Object.keys(value)) {
      attributeCounts.set(attr, (attributeCounts.get(attr) ?? 0) + 1);
    }
  }

  return {
    models,
    byId,
    byLowerId,
    byProvider,
    byMode,
    attributeCounts,
    source,
    etag,
    sha256,
    loadedAt: new Date().toISOString(),
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

class Store {
  #snapshot: Snapshot | null = null;

  /** Populated when upstream could not be reached but a local copy carried the boot. */
  lastError: string | null = null;

  get ready(): boolean {
    return this.#snapshot !== null;
  }

  /** Throws while there is no data: routes must check `ready` first. */
  get snapshot(): Snapshot {
    if (!this.#snapshot) throw new Error('The dataset is not loaded yet');
    return this.#snapshot;
  }

  /**
   * Loads the dataset once, at boot.
   *
   * The local file is read first, and its persisted ETag drives a conditional request: a 304
   * means the local copy is current and nothing is transferred. Only a genuinely newer upstream
   * is downloaded, and it is then written back to disk.
   *
   * Fails only when there is neither a local copy nor a reachable upstream. Anything else —
   * timeouts, 5xx, DNS — degrades to serving the local file with the error recorded.
   */
  async init(datasetPath: string = config.datasetPath): Promise<void> {
    const local = await readLocalDataset(datasetPath);

    try {
      const result = await fetchDataset(local?.etag);

      if (result.status === 'not_modified' && local) {
        // Atomic swap: the snapshot is built whole before the reference is replaced.
        this.#snapshot = buildSnapshot(local.json, 'local', local.etag, local.sha256);
        this.lastError = null;
        return;
      }

      if (result.status === 'updated') {
        this.#snapshot = buildSnapshot(result.body!, 'upstream', result.etag, result.sha256);
        this.lastError = null;
        await writeLocalDataset(result.body!, result.etag, result.sha256!, datasetPath);
        return;
      }

      // A 304 without a local copy: the ETag we sent cannot have been ours. Treat it as a
      // failed revalidation rather than pretending we have data.
      throw new Error('Upstream answered 304 but there is no local dataset to serve');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!local) {
        throw new Error(`Could not load the initial dataset: ${message}`);
      }

      try {
        this.#snapshot = buildSnapshot(local.json, 'local', local.etag, local.sha256);
      } catch (localError) {
        const localMessage = localError instanceof Error ? localError.message : String(localError);
        throw new Error(
          `Upstream failed (${message}) and the local dataset is unusable: ${localMessage}`,
        );
      }
      this.lastError = message;
    }
  }

  /** Injects an already materialized dataset. Tests only. */
  loadFromString(json: string): void {
    this.#snapshot = buildSnapshot(json);
    this.lastError = null;
  }
}

export const store = new Store();

// The class is exported so tests can work on a throwaway instance instead of the singleton.
export { Store, buildSnapshot };
