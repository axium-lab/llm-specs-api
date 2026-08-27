/** The normalization applied to the dataset before it is written to disk. */

import { describe, expect, test } from 'bun:test';
import { PARSE_VERSION, parse } from '../src/data/parse.ts';

const UPSTREAM = {
  sample_spec: {
    input_cost_per_token: 0,
    litellm_provider: 'one of https://docs.litellm.ai/docs/providers',
    mode: 'one of: chat, embedding',
  },
  'gpt-4o': {
    max_input_tokens: 128000,
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000025,
  },
  fallback_generalizations: {
    rules: [{ name: 'bedrock-claude-ids', model_info: { litellm_provider: 'bedrock' } }],
  },
};

const parsed = (value: unknown): Record<string, any> =>
  JSON.parse(parse(JSON.stringify(value))) as Record<string, any>;

describe('edit 1: litellm_provider -> provider', () => {
  test('renames the field in every entry that carries it', () => {
    const data = parsed(UPSTREAM);

    expect(data['gpt-4o'].provider).toBe('openai');
    expect(data['gpt-4o']).not.toHaveProperty('litellm_provider');
    // `sample_spec` is not a model, but it carries the field and is renamed like the rest.
    expect(data['sample_spec'].provider).toBe('one of https://docs.litellm.ai/docs/providers');
  });

  test('reaches nested occurrences, so the old name survives nowhere', () => {
    // `fallback_generalizations` is not a model entry, but its router rules carry the field.
    const data = parsed(UPSTREAM);
    expect(data['fallback_generalizations'].rules[0].model_info).toEqual({ provider: 'bedrock' });
  });

  test('leaves objects without the field untouched', () => {
    const data = parsed({ x: { a: 1, b: { c: [2, 'three', null] } } });
    expect(data['x']).toEqual({ a: 1, b: { c: [2, 'three', null] } });
  });

  test('keeps the field in its original position', () => {
    const data = parsed(UPSTREAM);
    expect(Object.keys(data['gpt-4o'])).toEqual([
      'max_input_tokens',
      'provider',
      'mode',
      'input_cost_per_token',
    ]);
  });

  test('does not overwrite an existing provider', () => {
    const data = parsed({ 'gpt-4o': { provider: 'openai', litellm_provider: 'azure' } });
    expect(data['gpt-4o'].provider).toBe('openai');
    expect(data['gpt-4o'].litellm_provider).toBe('azure');
  });
});

describe('parse', () => {
  test('is idempotent, which is what lets an older copy be brought forward', () => {
    const once = parse(JSON.stringify(UPSTREAM));
    expect(parse(once)).toBe(once);
  });

  test('preserves entry order and count', () => {
    expect(Object.keys(parsed(UPSTREAM))).toEqual(Object.keys(UPSTREAM));
  });

  test('preserves values exactly, tiny rates included', () => {
    const rates = { 'm': { litellm_provider: 'p', a: 1e-7, b: 0.0000025, c: 1e-9, d: 12345.6789 } };
    const data = parsed(rates);
    expect(data['m'].a).toBe(1e-7);
    expect(data['m'].b).toBe(0.0000025);
    expect(data['m'].c).toBe(1e-9);
    expect(data['m'].d).toBe(12345.6789);
  });

  test('emits upstream indentation and a trailing newline', () => {
    const out = parse(JSON.stringify(UPSTREAM));
    expect(out).toStartWith('{\n    "sample_spec"');
    expect(out).toEndWith('}\n');
  });

  test('rejects a body that is not JSON, so a bad download never reaches disk', () => {
    expect(() => parse('{ not json at all')).toThrow();
  });

  test('the version is a positive integer', () => {
    expect(PARSE_VERSION).toBeGreaterThan(0);
  });
});
