
export const PARSE_VERSION = 1;


export function parse(json: string): string {
  let data = JSON.parse(json) as Record<string, unknown>;

  data = renameKey(data, 'litellm_provider', 'provider') as Record<string, unknown>;
  return `${JSON.stringify(data, null, 4)}\n`;
}


function renameKey(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = renameKey(node[i], from, to);
    return node;
  }

  if (typeof node !== 'object' || node === null) return node;

  const fields = node as Record<string, unknown>;
  // The target is already taken: renaming would drop a value, so the entry is left alone.
  const rename = from in fields && !(to in fields);

  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    out[rename && field === from ? to : field] = renameKey(value, from, to);
  }
  return out;
}
