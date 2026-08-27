# llm-pricing-api

REST API over the LiteLLM catalog of [LLM model prices and context windows](https://github.com/BerriAI/litellm).

Serves **3038 models** from **123 providers** out of memory, with no database. The dataset ships
with the image and is revalidated against upstream once, at boot, with a conditional request
(`If-None-Match`), so an instance whose copy is already current transfers **0 bytes**.

## Getting started

```bash
bun install
bun run dev          # http://localhost:8080
bun test
bun run typecheck
```

## Layout

```
data/    the dataset and its .meta.json sidecar — the source of truth
src/     API code
test/    tests
```

## How the dataset is loaded

`data/model_prices_and_context_window.json` is the source of truth: it is versioned, baked into
the image, and read at boot. Next to it, `model_prices_and_context_window.meta.json` persists the
`{ etag, sha256, fetchedAt }` of the last download — a file has no ETag of its own, the server
issues it, so it has to be stored explicitly.

On boot the instance:

1. Reads both files and checks that the sidecar's `sha256` matches the JSON on disk. A mismatch
   means the pair got out of sync, and the ETag is discarded.
2. Sends a conditional `GET` to `UPSTREAM_URL` with `If-None-Match`.
   - **304** — the local copy is current. Nothing is transferred.
   - **200** — upstream is newer. It is served and written back to disk, sidecar included.
   - **error or timeout** — the local copy is served and the reason is reported in `/health` as
     `startup_error`. The service boots without network.
3. Fails only when there is neither a usable local copy nor a reachable upstream.

There is no background refresh and no admin endpoint: **restarting or redeploying the instance is
what updates the dataset**. On Cloud Run the filesystem is an ephemeral tmpfs, so a write-back
lasts only for the life of the instance; it is the copy in the image that makes cold boots cheap.

> **If you mount a Cloud Storage bucket**, do not mount it over `data/`: GCS FUSE hides whatever
> sits below the mount point, just like any Linux `mount`, and you would lose the file baked into
> the image. Use a separate path (`/mnt/dataset`).

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Injected by Cloud Run. |
| `DATASET_PATH` | `data/model_prices_and_context_window.json` | The source of truth. The sidecar path is derived from it. |
| `UPSTREAM_URL` | `litellm_internal_staging` branch | See *Upstream risk*. |
| `FETCH_TIMEOUT_MS` | `30000` | A timeout is not fatal: the local copy is served. |
| `DEFAULT_LIMIT` / `MAX_LIMIT` | `50` / `500` | |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status, dataset age, source and `startup_error`. |
| `GET` | `/v1/models` | Listing with filters and pagination. |
| `GET` | `/v1/models/by-id?id=` | Lookup by query param (for ids not representable in a path). |
| `GET` | `/v1/models/*` | Lookup by id, accepts ids containing `/`. |
| `GET` | `/v1/providers` | 123 providers with their counts. |
| `GET` | `/v1/modes` | 15 modes with their counts. |
| `GET` | `/v1/attributes` | 144 attributes, flagging the 81 pricing ones. |
| `GET` | `/v1/meta` | Counts, source, ETag and sha256 of the dataset. |
| `GET` | `/v1/compare?ids=a,b,c` | Side-by-side comparison of several models. |
| `POST` | `/v1/estimate` | Cost calculation for a single call. |

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
carry unvalidated data or disappear. A cold start with upstream down is survivable — the copy in
the image is served and `/health` reports `startup_error` — but the branch going away silently
means every boot keeps shipping whatever version was last baked in. For production, consider
`main` through `UPSTREAM_URL`.

## Deploying to Cloud Run

```bash
gcloud run deploy llm-pricing-api --source . --region europe-west1 \
  --min-instances 1 --cpu-boost --allow-unauthenticated
```

`--min-instances 1` is no longer load-bearing: a cold start revalidates the copy in the image with
`If-None-Match` and, on a 304, transfers nothing — and a boot while GitHub is down now serves the
local dataset instead of failing. Keep it if you care about cold-start latency, drop it if you
care about idle cost.
