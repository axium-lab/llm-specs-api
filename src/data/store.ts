/**
 * In-memory cache of the dataset, with prebuilt indexes and an atomic swap.
 *
 * There is no database: this is read-only data that changes rarely, and on Cloud Run every
 * instance is ephemeral. A DB would add latency and one more service without buying anything.
 */

import { config } from '../config.ts';
import { type ModelEntry, isModelEntry } from '../types.ts';
import { fetchDataset } from './fetcher.ts';

export interface Snapshot {
  models: ModelEntry[];
  byId: Map<string, ModelEntry>;
  /** Lowercase secondary index. One lowercase key can map to several real keys. */
  byLowerId: Map<string, ModelEntry[]>;
  byProvider: Map<string, ModelEntry[]>;
  byMode: Map<string, ModelEntry[]>;
  attributeCounts: Map<string, number>;
  etag?: string;
  sha256?: string;
  loadedAt: string;
}

function buildSnapshot(json: string, etag?: string, sha256?: string): Snapshot {
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

export interface RefreshOutcome {
  status: 'updated' | 'not_modified' | 'failed';
  error?: string;
  models?: number;
}

class Store {
  #snapshot: Snapshot | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  lastRefreshAt: string | null = null;
  lastRefreshStatus: RefreshOutcome['status'] | null = null;
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
   * Refreshes from upstream. On failure it keeps the previous copy: the API never returns an
   * error because of a failed refresh, it just serves slightly older data.
   */
  async refresh(): Promise<RefreshOutcome> {
    try {
      const result = await fetchDataset(this.#snapshot?.etag);
      this.lastRefreshAt = new Date().toISOString();

      if (result.status === 'not_modified') {
        this.lastRefreshStatus = 'not_modified';
        this.lastError = null;
        return { status: 'not_modified', models: this.#snapshot?.models.length };
      }

      // Atomic swap: the snapshot is built whole before the reference is replaced.
      this.#snapshot = buildSnapshot(result.body!, result.etag, result.sha256);
      this.lastRefreshStatus = 'updated';
      this.lastError = null;
      return { status: 'updated', models: this.#snapshot.models.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastRefreshAt = new Date().toISOString();
      this.lastRefreshStatus = 'failed';
      this.lastError = message;
      return { status: 'failed', error: message };
    }
  }

  /** Initial load. Fails loudly: without data there is no point in accepting traffic. */
  async init(): Promise<void> {
    const outcome = await this.refresh();
    if (outcome.status === 'failed') {
      throw new Error(`Could not load the initial dataset: ${outcome.error}`);
    }
  }

  startAutoRefresh(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.refresh();
    }, config.refreshIntervalMs);
    this.#timer.unref?.();
  }

  stopAutoRefresh(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Injects an already materialized dataset. Tests only. */
  loadFromString(json: string): void {
    this.#snapshot = buildSnapshot(json);
    this.lastRefreshStatus = 'updated';
    this.lastRefreshAt = this.#snapshot.loadedAt;
  }
}

export const store = new Store();
export { buildSnapshot };
