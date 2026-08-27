import { config } from '../config.ts';

export interface FetchResult {
  status: 'updated' | 'not_modified';
  /** Only present when `status === 'updated'`. */
  body?: string;
  etag?: string;
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

  // No hash is computed here: the body is not what gets stored. `parse` rewrites it first, and
  // the sha256 that matters is the one of the file that actually lands on disk.
  return {
    status: 'updated',
    body: await response.text(),
    etag: response.headers.get('etag') ?? undefined,
  };
}
