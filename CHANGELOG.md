# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE`, with attribution for the vendored LiteLLM dataset.
- Documentation site under `docs/`, published on GitHub Pages: landing page, API overview, model endpoints,
  the cost estimator, and how the dataset is loaded.
- `CONTRIBUTING.md` and this changelog.
- `license`, `author`, `repository`, `homepage`, `bugs` and `keywords` in `package.json`.

### Changed

- `README.md` rewritten for an open source audience. The dataset lifecycle, the pricing decisions and the
  upstream risk notes moved to [`docs/dataset.html`](https://llm-pricing.dev/dataset.html), in full.
- Corrected two counts that no longer matched the dataset: 258 (not 259) models declare
  `output_cost_per_token: 0`, and 82 % (not 81 %) of the ids contain a `/`.

### Known limitations

Documented rather than fixed, in the README and on the estimator page: `usage.web_search` and
`usage.search_results` are accepted but never billed; `options.tier_policy: "marginal"` falls through to the
base rate instead of computing bands; `tiered_pricing` is not read; Databricks DBU rates never produce a total;
and malformed JSON answers `500` instead of `400`.

## [1.0.0]

### Added

- REST API over LiteLLM's catalog of model prices and context windows: `/v1/models` with filters, sorting,
  projection and pagination; lookup by id through a wildcard route plus a `by-id` escape hatch; `/v1/compare`;
  and the `/v1/providers`, `/v1/modes`, `/v1/attributes` and `/v1/meta` facets.
- `POST /v1/estimate`: cost of a single call with a per-line breakdown, each line naming the literal dataset
  key it was billed with. Decimal arithmetic throughout, context tiers as a flag over the whole request, cache
  TTL axes, service tiers with documented degradation, regional uplift, and `unpriced[]` for usage the dataset
  cannot price.
- Local dataset management: the copy in `data/` is the source of truth, revalidated upstream at boot with
  `If-None-Match`. A `304` transfers nothing, a `200` is normalized and written back, and an unreachable
  upstream leaves the service running on the local copy with the reason reported in `/health`.
- RFC 9457 (`application/problem+json`) errors with stable `type` slugs.
- Containerized for Cloud Run, dataset baked into the image.
- Test suite covering the HTTP surface, the estimate engine, dataset resolution, the cost-key catalog and the
  upstream normalization.
