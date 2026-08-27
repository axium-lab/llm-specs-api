# Contributing

Issues and pull requests are welcome.

## Getting set up

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev        # http://localhost:8080, with file watching
bun test
bun run typecheck  # tsc --noEmit
```

There is no build step and no database — Bun runs the TypeScript directly, and the dataset is a file in `data/`.

## The one hard rule

**Every endpoint and every pricing rule keeps a test that proves it.** A PR that changes behaviour without a
test that fails before it and passes after it will be asked for one.

Concretely:

- HTTP behaviour → `test/api.test.ts`, which mounts `createApp()` on an ephemeral port against the real dataset.
- A pricing rule → `test/estimate.test.ts`. Its fixtures are golden values worked out by hand against the JSON,
  with the arithmetic written in a comment. Keep that habit: a fixture nobody can re-derive is not a test.
- A new cost key → nothing, usually. `test/catalog.test.ts` walks the whole dataset and fails when a pricing key
  appears that `parseCostKey` cannot describe. That test is the tripwire for upstream adding a key we would
  otherwise silently ignore when billing; when it fires, describe the key in `src/pricing/catalog.ts`.

## How the code is laid out

| Directory | Owns |
|---|---|
| `src/data/` | The dataset: reading the local copy, revalidating it upstream, normalizing it, and the in-memory snapshot with its indexes. |
| `src/pricing/` | The cost engine: `catalog.ts` describes every cost key, `resolve.ts` picks which one applies, `estimate.ts` does the arithmetic. |
| `src/routes/` | The HTTP surface. Thin — routing, validation and error shapes only. |
| `src/lib/` | Filtering for the listing endpoint, and the RFC 9457 error helper. |

Two conventions that are load-bearing:

- **`src/data/parse.ts` is the only place where upstream's shape is adjusted.** If a field needs renaming or
  reshaping, it happens there and nowhere else — the file on disk, the indexes and the API responses all see the
  same normalized data. Bump `PARSE_VERSION` when you change it; a boot that finds an older version renormalizes
  the local copy.
- **A missing rate is never substituted with zero.** 258 models legitimately declare `output_cost_per_token: 0`,
  so "free" and "unknown" must stay distinguishable. Unknown usage goes to `unpriced[]`.

## Money

Costs accumulate in `Decimal` (decimal.js), never in `number`. The dataset carries rates as small as `1.3e-10`
and floating point noise that is already serialized into the file (`1.2999000000000001e-07`). If you find
yourself writing `+` between two rates, that is the bug.

## Documentation

The site under `docs/` is plain HTML — no generator, no build. `index.html` carries its own CSS inline; the API
pages share `docs/styles.css`.

**Examples in the docs are captured from a running instance, not written from memory.** If you change a response
shape, run the request and paste what came back. When you add a page, add it to `docs/sitemap.xml` too.

## Commits and PRs

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`). Keep a PR to one concern, and
say in the description what you ran to convince yourself it works.

### Regenerating the social image

`docs/og-image.html` is the source of `docs/og-image.png`. To re-export it after editing:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars \
  --screenshot="$PWD/docs/og-image.png" --window-size=1200,630 --default-background-color=0b0e14ff \
  "file://$PWD/docs/og-image.html"
```
