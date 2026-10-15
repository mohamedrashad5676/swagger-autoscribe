import type { ContractFacts, FieldDetail } from './contract-facts';

export type ContractSection = 'access' | 'parameters' | 'request' | 'response' | 'errors';
export const ALL_SECTIONS: ContractSection[] = ['access', 'parameters', 'request', 'response', 'errors'];

const tick = (s: string): string => `\`${s}\``;

function fieldLines(fields: FieldDetail[], indent = ''): string[] {
  const lines: string[] = [];
  for (const f of fields) {
    const parts = [f.type, f.required ? 'required' : 'optional', ...f.notes];
    lines.push(`${indent}- ${tick(f.name)} — ${parts.join(', ')}`);
    if (f.children.length > 0) lines.push(...fieldLines(f.children, `${indent}  `));
  }
  return lines;
}

/** Deterministic Markdown rendering of the contract facts (Swagger UI renders it). */
export function renderContract(c: ContractFacts, sections: ContractSection[] = ALL_SECTIONS): string {
  const blocks: string[] = [];
  const want = new Set(sections);

  if (want.has('access') && c.access) {
    const parts: string[] = [];
    parts.push(c.access.public ? 'Public endpoint — no authentication is required.' : `Requires authentication${c.access.scheme ? ` (${c.access.scheme})` : ''}.`);
    if (c.access.permissions.length === 1) parts.push(`The caller needs the ${tick(c.access.permissions[0])} permission.`);
    else if (c.access.permissions.length > 1) parts.push(`The caller needs all of these permissions: ${c.access.permissions.map(tick).join(', ')}.`);
    blocks.push(`**Access.** ${parts.join(' ')}`);
  }

  if (want.has('parameters') && c.parameters.length > 0) {
    const lines: string[] = [];
    for (const where of ['path', 'query', 'header', 'cookie'] as const) {
      const group = c.parameters.filter((p) => p.where === where);
      if (group.length === 0) continue;
      lines.push(`**${where[0].toUpperCase()}${where.slice(1)} parameters**`);
      for (const p of group) {
        lines.push(`- ${tick(p.name)} — ${[p.type, p.required ? 'required' : 'optional', ...p.notes].join(', ')}${p.description ? `. ${p.description}` : ''}`);
      }
    }
    if (c.pagination) lines.push(`Pagination: ${c.pagination}.`);
    blocks.push(lines.join('\n'));
  }

  if (want.has('request') && c.request && c.request.fields.length > 0) {
    blocks.push([`**Request body** (${c.request.contentType}${c.request.list ? ', a list of the object below' : ''})`, ...fieldLines(c.request.fields)].join('\n'));
  }

  if (want.has('response') && c.responses.length > 0) {
    for (const r of c.responses) {
      const shape = r.fields.length === 0 ? (r.scalar ? `a ${r.scalar}` : 'no body') : r.list ? 'a list' : r.envelope ? 'an envelope with the items and paging totals' : 'an object';
      blocks.push([`**Response ${r.status} ${r.label}** — ${shape}`, ...fieldLines(r.fields)].join('\n'));
    }
  }

  if (want.has('errors') && c.failures.length > 0) {
    const lines = ['**Failures**'];
    for (const f of c.failures) {
      if (f.messages.length === 0) lines.push(`- ${tick(String(f.status))} ${f.label}`);
      else
        for (const m of f.messages) {
          // A message that only repeats the status text adds nothing.
          const text = m.text === f.label ? '' : ` — ${m.text}`;
          lines.push(`- ${tick(String(f.status))} ${f.label}${text}${m.when ? ` (when ${tick(m.when)})` : ''}`);
        }
      if (f.more > 0) lines.push(`- … and ${f.more} more ${tick(String(f.status))} case${f.more === 1 ? '' : 's'}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
