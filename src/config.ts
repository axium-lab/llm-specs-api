/** Service configuration, resolved from environment variables. */

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

export const config = {
  port: int('PORT', 8080),

  /**
   * The `litellm_internal_staging` branch, by explicit project decision. It is an internal
   * branch: it may be force-pushed or disappear. Configurable through the environment so it can
   * be repointed without a redeploy.
   */
  upstreamUrl:
    process.env.UPSTREAM_URL ??
    'https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/litellm_internal_staging/model_prices_and_context_window.json',

  refreshIntervalMs: int('REFRESH_INTERVAL_MS', 60 * 60 * 1000),
  fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 30_000),

  /** Guards POST /admin/refresh. If unset, the endpoint stays disabled. */
  adminToken: process.env.ADMIN_TOKEN,

  defaultLimit: int('DEFAULT_LIMIT', 50),
  maxLimit: int('MAX_LIMIT', 500),
} as const;
