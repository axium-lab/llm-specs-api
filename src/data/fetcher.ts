/**
 * Dataset download from upstream, using conditional requests.
 *
 * raw.githubusercontent.com supports ETag/If-None-Match and answers 304 with an empty body, so
 * the periodic refresh transfers nothing while the file is unchanged. That is what keeps the
 * bandwidth negligible even when Cloud Run spins up many instances.
 */

import { createHash } from 'node:crypto';
import { config } from '../config.ts';

export interface FetchResult {
  status: 'updated' | 'not_modified';
  /** Only present when `status === 'updated'`. */
  body?: string;
  etag?: string;
  sha256?: string;
}

export async function fetchDataset(previousEtag?: string): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': 'llm-pricing-api',
    Accept: 'application/json, text/plain',
  };
  if (previousEtag) headers['If-None-Match'] = previousEtag;

  const response = await fetch(config.upstreamUrl, {
    headers,
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });

  if (response.status === 304) {
    return { status: 'not_modified', etag: previousEtag };
  }

  if (!response.ok) {
    throw new Error(`Upstream responded ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  return {
    status: 'updated',
    body,
    etag: response.headers.get('etag') ?? undefined,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}
