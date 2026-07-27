/**
 * Counts the entries of the LiteLLM pricing dataset.
 *
 * Beware the "obvious" number: `Object.keys(data).length` returns 3040, but TWO of those
 * entries are not models — `sample_spec` (schema documentation) and `fallback_generalizations`
 * (router regex rules) — so the real model count is 3038.
 *
 * `sample_spec` DOES carry `litellm_provider`, holding a descriptive value instead of a real
 * provider, which is why it has to be excluded by name and not just by checking the shape of
 * the object.
 *
 * The API exposes the same figures through GET /v1/meta.
 */

import { readFileSync } from 'node:fs';

const NON_MODEL_KEYS = new Set(['sample_spec', 'fallback_generalizations']);

const filePath = new URL('./data/model_prices_and_context_window.json', import.meta.url);
const data = JSON.parse(readFileSync(filePath, 'utf8'));

const rawKeys = Object.keys(data);
const models = rawKeys.filter(
  (key) =>
    !NON_MODEL_KEYS.has(key) &&
    typeof data[key] === 'object' &&
    data[key] !== null &&
    'litellm_provider' in data[key],
);

const attributes = new Set();
for (const key of models) {
  for (const attr of Object.keys(data[key])) attributes.add(attr);
}

console.log(`Top-level entries: ${rawKeys.length}`);
console.log(`  - not models:    ${rawKeys.length - models.length} (${[...NON_MODEL_KEYS].join(', ')})`);
console.log(`Real models:       ${models.length}`);
console.log(`Distinct attributes: ${attributes.size}`);
