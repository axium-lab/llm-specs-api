# llm-pricing-api

REST API over the LiteLLM catalog of [LLM model prices and context windows](https://github.com/BerriAI/litellm).

Serves **3038 models** from **123 providers** out of memory, with no database. The dataset is
downloaded from upstream at boot and refreshed in the background with conditional requests
(`If-None-Match`), so a refresh with no changes transfers **0 bytes**.

## Getting started

```bash
bun install
bun run dev          # http://localhost:8080
bun test
bun run typecheck
```

## Layout

```
data/    copy of the dataset — today it is only used as a test fixture
src/     API code
test/    tests
```

The runtime **does not read `data/`**: it downloads the dataset from upstream at boot. The local
copy exists so the tests do not depend on the network.

> **If you mount a Cloud Storage bucket**, do not mount it over `data/`: GCS FUSE hides whatever
> sits below the mount point, just like any Linux `mount`, and you would lose the file baked into
> the image. Use a separate path (`/mnt/dataset`).

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Injected by Cloud Run. |
| `UPSTREAM_URL` | `litellm_internal_staging` branch | See *Upstream risk*. |
| `REFRESH_INTERVAL_MS` | `3600000` (1 h) | |
| `FETCH_TIMEOUT_MS` | `30000` | |
| `ADMIN_TOKEN` | — | Unset, `POST /admin/refresh` answers 404. |
| `DEFAULT_LIMIT` / `MAX_LIMIT` | `50` / `500` | |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status and cache age. |
| `GET` | `/v1/models` | Listing with filters and pagination. |
| `GET` | `/v1/models/by-id?id=` | Lookup by query param (for ids not representable in a path). |
| `GET` | `/v1/models/*` | Lookup by id, accepts ids containing `/`. |
| `GET` | `/v1/providers` | 123 providers with their counts. |
| `GET` | `/v1/modes` | 15 modes with their counts. |
| `GET` | `/v1/attributes` | 144 attributes, flagging the 81 pricing ones. |
| `GET` | `/v1/meta` | Counts, source, ETag and sha256 of the dataset. |
| `GET` | `/v1/compare?ids=a,b,c` | Side-by-side comparison of several models. |
| `POST` | `/v1/estimate` | Cost calculation for a single call. |
| `POST` | `/admin/refresh` | Manual refresh (requires `Authorization: Bearer`). |

Filters for `/v1/models`: `provider`, `mode`, `q`, any `supports_*`, `min_input_tokens`,
`max_input_cost`, `sort=field:asc|desc`, `fields`, `limit`, `offset`.

```bash
curl 'localhost:8080/v1/models?provider=anthropic&mode=chat&fields=id,input_cost_per_token&limit=5'
curl 'localhost:8080/v1/models/bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0'
```

## `POST /v1/estimate`

```bash
curl -X POST localhost:8080/v1/estimate -H 'content-type: application/json' -d '{
  "model": "claude-sonnet-4-5",
  "usage": {
    "input_tokens": 190000, "output_tokens": 4000,
    "cache_read_tokens": 20000,
    "cache_creation_tokens_by_ttl": { "1h": 8000 }
  }
}'
```

It returns an auditable breakdown, not just a total. Every line carries `rate_key`, the literal
dataset key, so the calculation can be checked against the JSON:

```
input.text         190000 x 0.000006   = 1.14    [input_cost_per_token_above_200k_tokens]
output.text          4000 x 0.0000225  = 0.09    [output_cost_per_token_above_200k_tokens]
cache_read.text     20000 x 6e-7       = 0.012   [cache_read_input_token_cost_above_200k_tokens]
cache_write.1h       8000 x 0.000012   = 0.096   [cache_creation_input_token_cost_above_1hr_above_200k_tokens]
                                        ------
                                         1.338 USD
```

### Decisions worth knowing about

**The context tier is a flag, not marginal.** If the prompt crosses the threshold, the *whole*
request is repriced — output included, as shown above. The cleanest evidence is that the dataset
defines `output_cost_per_token_above_200k_tokens`: an output price gated on an input threshold
only makes sense as a flag. It matches LiteLLM and what Anthropic, Google and OpenAI document.
Configurable through `options.tier_policy`.

**`_above_1hr` is not a volume threshold**, it is Anthropic's 1 hour cache TTL, and it composes
with the context tier (hence the quadruple key in the example above).

**A missing rate is never billed as 0.** 249 models legitimately declare
`output_cost_per_token: 0.0`, so "free" and "unknown" stay distinguishable: the unknown ones go
to `unpriced[]`.

**Decimal arithmetic, not `number`.** The dataset ships floating point noise already serialized
(`1.2999000000000001e-07`) and rates as small as `1.3e-10`.

**Databricks DBU rates are not dollars** and come back in a separate total.

**Absurd upstream prices are not corrected** (there are 18, such as `wandb/*` at $100,000/MTok):
they are flagged with `SUSPICIOUS_RATE_MAGNITUDE`. Note that `o1-pro` at $600/MTok is correct and
sits in the allowlist.

## Dataset details that shape the design

- **2471 of 3038 ids (81%) contain a `/`**, and one of them ends in `/`
  (`fireworks_ai/accounts/fireworks/models/`). Since Express drops the trailing slash, that one is
  only reachable through `/v1/models/by-id`.
- 4 ids contain a literal `*`; 244 contain `:`.
- `together_ai/baai/...` and `together_ai/BAAI/...` coexist with identical content. Lookup is
  case-sensitive; a match that differs only by case answers `409`.
- Express 5 requires a named wildcard (`*splat`) and exposes the segments as an **array**.

## Upstream risk

By default we point at `litellm_internal_staging`, an **internal** branch: it can be force-pushed,
carry unvalidated data or disappear. If a refresh fails the in-memory copy is kept, but **a cold
start with upstream down leaves the API with no data** (there is no local fallback). For
production, consider `main` through `UPSTREAM_URL`.

## Deploying to Cloud Run

```bash
gcloud run deploy llm-pricing-api --source . --region europe-west1 \
  --min-instances 1 --cpu-boost --allow-unauthenticated
```

`--min-instances 1` avoids re-downloading 1.7 MB on every cold start and removes the scenario of
booting while GitHub is down.
