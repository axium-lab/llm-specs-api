/**
 * Reads and writes the on-disk copy of the dataset, which is the source of truth.
 *
 * A file has no ETag of its own — the server issues it — so the one that came with the last
 * download is persisted next to the JSON in a `.meta.json` sidecar. That is what lets a fresh
 * instance revalidate with `If-None-Match` and get a 304 instead of another 1.7 MB.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.ts';

export interface LocalDataset {
  json: string;
  /** Absent when there is no sidecar, or when it does not match the JSON on disk. */
  etag?: string;
  sha256: string;
}

interface DatasetMeta {
  etag?: string;
  sha256: string;
  fetchedAt: string;
}

export function metaPathFor(datasetPath: string): string {
  return datasetPath.endsWith('.json')
    ? `${datasetPath.slice(0, -'.json'.length)}.meta.json`
    : `${datasetPath}.meta.json`;
}

export function sha256Of(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Returns the dataset on disk, or `null` when there is none.
 *
 * The sidecar's ETag is only trusted when its sha256 matches the JSON actually on disk. A
 * mismatch means the pair got out of sync — a half-finished write, a hand-edited file — and
 * the caller must then download unconditionally. Erring towards one extra download is far
 * cheaper than serving stale data while believing it current.
 */
export async function readLocalDataset(
  datasetPath: string = config.datasetPath,
): Promise<LocalDataset | null> {
  let json: string;
  try {
    json = await readFile(datasetPath, 'utf8');
  } catch {
    return null;
  }

  const sha256 = sha256Of(json);

  try {
    const meta = JSON.parse(await readFile(metaPathFor(datasetPath), 'utf8')) as DatasetMeta;
    if (meta.sha256 === sha256) {
      return { json, etag: meta.etag, sha256 };
    }
    console.warn('[dataset] the sidecar does not match the local file; its ETag is discarded');
  } catch {
    // No sidecar, or an unreadable one: the file stands on its own, just without an ETag.
  }

  return { json, sha256 };
}

/**
 * Writes the dataset and its sidecar atomically (temp file + rename), JSON first.
 *
 * Never throws: on Cloud Run the filesystem is an ephemeral tmpfs and the write buys nothing,
 * so a failure must not take the service down. If the process dies between the two renames the
 * sidecar still describes the previous version, and the next boot simply downloads again.
 */
export async function writeLocalDataset(
  json: string,
  etag: string | undefined,
  sha256: string,
  datasetPath: string = config.datasetPath,
): Promise<boolean> {
  const meta: DatasetMeta = { etag, sha256, fetchedAt: new Date().toISOString() };

  try {
    await mkdir(dirname(datasetPath), { recursive: true });
    await writeAtomic(datasetPath, json);
    await writeAtomic(metaPathFor(datasetPath), `${JSON.stringify(meta, null, 2)}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dataset] could not persist to ${datasetPath}: ${message}`);
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
