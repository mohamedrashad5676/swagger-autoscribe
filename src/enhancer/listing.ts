type Json = Record<string, any>;

export interface ListingFacts {
  style: 'page' | 'offset' | 'cursor';
  /** Parameter names by role. */
  params: { page?: string; size?: string; offset?: string; cursor?: string };
  size?: { default?: unknown; min?: unknown; max?: unknown };
  page?: { default?: unknown; min?: unknown };
  sort: Array<{ name: string; values?: unknown[]; role: 'field' | 'direction' }>;
  search?: string;
  others: string[];
  /** Pagination fields found in the 2xx response schema. */
  meta: string[];
  /** The 2xx response is a bare array, so no total / next page information reaches the client. */
  bareArray: boolean;
}

const norm = (n: string): string => n.toLowerCase().replace(/[^a-z0-9[\]]/g, '');
const first = (names: string[], wanted: string[]): string | undefined => names.find((n) => wanted.includes(norm(n)));

const PAGE = ['page', 'pagenumber', 'pageno', 'pageindex', 'page[number]', 'page[index]'];
const SIZE = ['limit', 'pagesize', 'perpage', 'take', 'size', 'count', 'pagelimit', 'page[size]', 'page[limit]', 'itemsperpage', 'per_page'];
const OFFSET = ['offset', 'skip', 'start', 'page[offset]'];
const CURSOR = ['cursor', 'after', 'before', 'startingafter', 'endingbefore', 'pagetoken', 'nexttoken', 'startafter', 'page[cursor]', 'page[after]'];
const SORT_FIELD = ['sort', 'sortby', 'orderby', 'sortfield', 'sortkey'];
const SORT_DIR = ['order', 'sortorder', 'sortdirection', 'orderdirection', 'dir'];
const SEARCH = ['search', 'q', 'query', 'keyword', 'keywords', 'term', 'searchterm'];
const META = [
  'total', 'totalitems', 'totalcount', 'count', 'totalpages', 'pagecount', 'pages', 'page', 'limit', 'pagesize', 'perpage', 'offset',
  'nextcursor', 'next', 'nextpage', 'nextpagetoken', 'previous', 'prev', 'hasmore', 'hasnext', 'hasnextpage', 'hasprevious', 'haspreviouspage',
];

function deref(document: Json, node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    let cur: any = document;
    for (const part of node.$ref.slice(2).split('/')) cur = cur?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return deref(document, cur, depth + 1);
  }
  return node;
}

function queryParams(document: Json, operation: Json): Json[] {
  const out: Json[] = [];
  for (const raw of (operation.parameters as any[]) ?? []) {
    const p = deref(document, raw);
    if (p && p.in === 'query' && typeof p.name === 'string') out.push({ ...p, schema: deref(document, p.schema) });
  }
  return out;
}

/** Fields that describe pagination on the 2xx body: top level, or inside `meta` / `pagination` / `paging` / `pageInfo`. */
function responseMeta(document: Json, operation: Json): { meta: string[]; bareArray: boolean } {
  const responses = (operation.responses ?? {}) as Json;
  const code = Object.keys(responses).find((c) => /^2\d\d$/.test(c));
  const schema = deref(document, responses[code ?? '']?.content?.['application/json']?.schema);
  if (!schema) return { meta: [], bareArray: false };
  if (schema.type === 'array') return { meta: [], bareArray: true };
  const found: string[] = [];
  const scan = (props: Json | undefined, prefix: string): void => {
    for (const [k, v] of Object.entries(props ?? {})) {
      if (META.includes(norm(k)) && !found.includes(prefix + k)) found.push(prefix + k);
      else if (/^(meta|pagination|paging|pageinfo|links)$/i.test(k)) scan(deref(document, v)?.properties, `${k}.`);
    }
  };
  scan(schema.properties, '');
  return { meta: found, bareArray: false };
}

/** Pagination / sorting / search facts of a list operation, read from the finished document. */
export function listingOf(document: Json, operation: Json): ListingFacts | undefined {
  const params = queryParams(document, operation);
  if (params.length === 0) return undefined;
  const names = params.map((p) => p.name as string);
  const byName = new Map(params.map((p) => [p.name as string, p]));

  const page = first(names, PAGE);
  const size = first(names, SIZE);
  const offset = first(names, OFFSET);
  const cursor = first(names, CURSOR);
  let style: ListingFacts['style'] | undefined;
  if (cursor) style = 'cursor';
  else if (page && size) style = 'page';
  else if (offset && size) style = 'offset';
  else if (page) style = 'page';
  if (!style) return undefined;

  const used = new Set<string>([page, size, offset, cursor].filter((x): x is string => !!x));
  const sort: ListingFacts['sort'] = [];
  const sortField = first(names.filter((n) => !used.has(n)), SORT_FIELD);
  const sortDir = first(names.filter((n) => !used.has(n)), SORT_DIR);
  for (const [name, role] of [[sortField, 'field'], [sortDir, 'direction']] as const) {
    if (!name) continue;
    used.add(name);
    const s = byName.get(name)?.schema;
    const enumValues = Array.isArray(s?.enum) ? s.enum : Array.isArray(s?.items?.enum) ? s.items.enum : undefined;
    sort.push({ name, role, ...(enumValues ? { values: enumValues } : {}) });
  }
  const search = first(names.filter((n) => !used.has(n)), SEARCH);
  if (search) used.add(search);
  const others = names.filter((n) => !used.has(n));

  const sch = (n?: string): Json | undefined => (n ? byName.get(n)?.schema : undefined);
  const facts: ListingFacts = {
    style,
    params: { ...(page ? { page } : {}), ...(size ? { size } : {}), ...(offset ? { offset } : {}), ...(cursor ? { cursor } : {}) },
    sort,
    others,
    ...responseMeta(document, operation),
    ...(search ? { search } : {}),
  };
  const s = sch(size);
  if (s) facts.size = { default: s.default, min: s.minimum, max: s.maximum };
  const p = sch(page);
  if (p) facts.page = { default: p.default, min: p.minimum };
  return facts;
}

const code = (s: string): string => `\`${s}\``;

export function listingLines(f: ListingFacts): string[] {
  const lines: string[] = [];
  const n = (x: unknown): string => String(x);
  const sizeBits: string[] = [];
  if (f.size?.default !== undefined) sizeBits.push(`default ${n(f.size.default)}`);
  if (f.size?.min !== undefined) sizeBits.push(`min ${n(f.size.min)}`);
  if (f.size?.max !== undefined) sizeBits.push(`max ${n(f.size.max)}`);
  const sizeText = f.params.size ? `${code(f.params.size)} sets the page size${sizeBits.length ? ` (${sizeBits.join(', ')})` : ''}` : '';
  if (f.style === 'page') {
    const from = f.page?.min ?? f.page?.default;
    lines.push(`**Pagination.** Page based: ${code(f.params.page!)} picks the page${from !== undefined ? ` (starts at ${n(from)})` : ''}${sizeText ? `; ${sizeText}` : ''}.`);
  } else if (f.style === 'offset') {
    lines.push(`**Pagination.** Offset based: ${code(f.params.offset!)} items are skipped${sizeText ? `; ${sizeText}` : ''}.`);
  } else {
    lines.push(`**Pagination.** Cursor based: send ${code(f.params.cursor!)} from the previous response to get the next page${sizeText ? `; ${sizeText}` : ''}.`);
  }
  const field = f.sort.find((s) => s.role === 'field');
  const dir = f.sort.find((s) => s.role === 'direction');
  if (field || dir) {
    const vals = (s?: { values?: unknown[] }): string => (s?.values ? ` (one of ${s.values.map((v) => code(n(v))).join(', ')})` : '');
    const parts: string[] = [];
    if (field) parts.push(`${code(field.name)}${vals(field)} chooses the field`);
    if (dir) parts.push(`${code(dir.name)}${vals(dir)} chooses the direction`);
    lines.push(`**Sorting.** ${parts.join('; ')}.`);
  }
  if (f.search) lines.push(`**Search.** ${code(f.search)} filters by text.`);
  if (f.others.length > 0) lines.push(`**Other query parameters.** ${f.others.slice(0, 12).map(code).join(', ')}${f.others.length > 12 ? ` and ${f.others.length - 12} more` : ''}.`);
  if (f.meta.length > 0) lines.push(`**Response.** Paging details come back as ${f.meta.slice(0, 8).map(code).join(', ')}.`);
  else if (f.bareArray) lines.push('**Response.** A plain array: the total count and the next page are not part of the response.');
  return lines;
}

export function listingExtension(f: ListingFacts): Json {
  return {
    style: f.style,
    ...f.params,
    ...(f.size ? { pageSize: { ...(f.size.default !== undefined ? { default: f.size.default } : {}), ...(f.size.max !== undefined ? { max: f.size.max } : {}) } } : {}),
    ...(f.sort.length ? { sort: Object.fromEntries(f.sort.map((s) => [s.role, { name: s.name, ...(s.values ? { values: s.values } : {}) }])) } : {}),
    ...(f.search ? { search: f.search } : {}),
    ...(f.meta.length ? { response: f.meta } : {}),
  };
}
