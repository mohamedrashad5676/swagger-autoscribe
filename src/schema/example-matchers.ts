import type { JsonSchema } from './source-schema-extractor';

// Name based example heuristics. A property NAME is split into lower-cased
// tokens (camelCase / snake_case / kebab-case / PascalCase) and matched on
// token boundaries — `paid` or `valid` never match "ends with id", and
// `format` never matches "ends with at".

export interface NameInfo {
  raw: string;
  tokens: string[];
  /** tokens joined without separators, lower-cased: `firstName` -> `firstname` */
  joined: string;
}

export interface ExampleMatcher {
  test: (name: NameInfo) => boolean;
  value: (name: NameInfo) => unknown;
}

export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export function nameInfo(raw: string): NameInfo {
  const tokens = tokenize(raw);
  return { raw, tokens, joined: tokens.join('') };
}

type Pred = (n: NameInfo) => boolean;

/** Whole name equals (`eq('firstname')` matches firstName, first_name, FirstName). */
export const eq =
  (target: string): Pred =>
  (n) =>
    n.joined === target.toLowerCase();

/** Name ends with these token(s): `endsWith('id')` matches userId, user_id — not `paid`. */
export const endsWith =
  (suffix: string): Pred =>
  (n) => {
    const s = suffix.toLowerCase();
    for (let i = 0; i < n.tokens.length; i++) {
      if (n.tokens.slice(i).join('') === s) return true;
    }
    return false;
  };

export const startsWith =
  (prefix: string): Pred =>
  (n) => {
    const s = prefix.toLowerCase();
    for (let i = 1; i <= n.tokens.length; i++) {
      if (n.tokens.slice(0, i).join('') === s) return true;
    }
    return false;
  };

/** Name contains these token(s) as a contiguous run: `contains('notmember')` matches isNotMember. */
export const contains =
  (needle: string): Pred =>
  (n) => {
    const s = needle.toLowerCase();
    for (let i = 0; i < n.tokens.length; i++) {
      let acc = '';
      for (let j = i; j < n.tokens.length; j++) {
        acc += n.tokens[j];
        if (acc === s) return true;
        if (acc.length >= s.length) break;
      }
    }
    return false;
  };

export const anyOf =
  (...preds: Pred[]): Pred =>
  (n) =>
    preds.some((p) => p(n));

export const match = (test: Pred, value: (n: NameInfo) => unknown): ExampleMatcher => ({ test, value });

export const UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const ISO_DATE_EXAMPLE = '2026-01-15T10:30:00.000Z';

export interface DefaultMatcherOptions {
  baseUrl: string;
}

/**
 * Generic, project-agnostic matchers. Ordered most-specific-first — first
 * compatible match wins. Project vocabulary (billing, meetings, …) belongs in
 * `examples.matchers` / `examples.byName`, not here.
 */
export function createDefaultMatchers(options: DefaultMatcherOptions): ExampleMatcher[] {
  const base = options.baseUrl.replace(/\/+$/, '');
  return [
    // sensitive — safe, obviously-fake placeholders
    match(contains('password'), () => 'ExamplePassword123!'),
    match(
      anyOf(contains('refreshtoken'), contains('accesstoken'), eq('token'), contains('apikey'), contains('secret')),
      () => 'eyJ...example-token',
    ),

    // identity / contact
    match(eq('otp'), () => '123456'),
    match(endsWith('email'), () => 'ahmed.hassan@example.com'),
    match(anyOf(eq('phone'), contains('phonenumber'), endsWith('phone'), eq('mobile')), () => '+201012345678'),
    match(eq('firstname'), () => 'Ahmed'),
    match(eq('lastname'), () => 'Hassan'),
    match(eq('name'), () => 'Ahmed Hassan'),
    match(eq('username'), () => 'ahmed.hassan'),
    match(anyOf(eq('picture'), eq('avatar')), () => `${base}/avatars/ahmed-hassan.jpg`),
    match(anyOf(eq('about'), eq('bio')), () => 'Engineering lead focused on platform reliability.'),
    match(eq('jobtitle'), () => 'Engineering Lead'),
    match(eq('department'), () => 'Engineering'),

    // location
    match(eq('country'), () => 'Egypt'),
    match(eq('city'), () => 'Cairo'),
    match(eq('state'), () => 'Cairo Governorate'),
    match(eq('timezone'), () => 'Africa/Cairo'),
    match(contains('address'), () => '12 Tahrir Square, Cairo'),
    match(anyOf(eq('ip'), eq('ipaddress')), () => '192.0.2.10'),

    // ids — always after the more specific name/email/etc checks above
    match(eq('id'), () => UUID_EXAMPLE),
    match(endsWith('id'), () => UUID_EXAMPLE),

    // urls
    match(
      anyOf(endsWith('url'), eq('link'), eq('website')),
      (n) => `${base}/${n.tokens.filter((t) => t !== 'url').join('-') || 'resource'}/example`,
    ),

    // dates / times — `format: date-time` already covers real `Date` fields;
    // this backstops string-typed-but-date-named fields.
    match(anyOf(endsWith('at'), endsWith('date'), endsWith('time'), contains('period')), () => ISO_DATE_EXAMPLE),

    // money / numeric domain fields
    match(eq('currency'), () => 'USD'),
    match(
      anyOf(
        eq('price'),
        eq('amount'),
        eq('totalprice'),
        eq('discount'),
        eq('tax'),
        eq('balance'),
        eq('subtotal'),
        endsWith('amount'),
        endsWith('price'),
      ),
      () => '49.99',
    ),
    match(eq('percentage'), () => 15),
    match(eq('page'), () => 1),
    match(anyOf(eq('limit'), eq('capacity')), () => 20),
    match(eq('total'), () => 42),
    match(eq('totalpages'), () => 3),
    match(anyOf(eq('count'), contains('usage')), () => 5),
    match(eq('totalsize'), () => 1048576),

    // misc generic
    match(eq('title'), () => 'Weekly Sync'),
    match(eq('description'), () => 'A short description of the resource.'),
    match(eq('key'), () => 'primary_key'),
    match(eq('code'), () => 'ABC123'),
    match(eq('message'), () => 'Operation completed successfully.'),
    match(eq('status'), () => 'active'),
    match(anyOf(eq('role'), eq('rolename')), () => 'Admin'),
    match(eq('type'), () => 'standard'),
    match(eq('platform'), () => 'web'),
    match(eq('idempotencykey'), () => 'a1b2c3d4-req-2026-01-15'),
    match(eq('notes'), () => 'Upgraded per customer request.'),
    match(eq('comment'), () => 'Looks good, approved.'),
    match(eq('color'), () => '#4F46E5'),
    match(contains('hash'), () => 'ex_1a2b3c4d5e6f7890'),
    match(anyOf(eq('failurereason'), eq('failuremessage')), () => 'Card declined by issuing bank.'),
    match(contains('price'), () => '49.99'),

    // date-range query params (createdFrom/createdTo/updatedFrom/updatedTo)
    match(anyOf(endsWith('from'), endsWith('to')), () => ISO_DATE_EXAMPLE),

    // low-priority generic fallbacks — only reached when nothing more specific matched
    match(endsWith('by'), () => UUID_EXAMPLE),
    match(endsWith('name'), () => 'Example name'),
    match(contains('value'), () => 'sample_value'),

    // booleans
    match(
      anyOf(
        eq('active'),
        eq('isactive'),
        eq('islocked'),
        eq('deleted'),
        eq('autorenew'),
        eq('recurring'),
        eq('success'),
        eq('default'),
        eq('enabled'),
        eq('isenabled'),
        eq('verified'),
        eq('isverified'),
        contains('notmember'),
        contains('requires'),
      ),
      (n) => !anyOf(eq('deleted'), contains('notmember'))(n),
    ),
  ];
}

export type SchemaForCoercion = Pick<JsonSchema, 'type' | 'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'pattern'>;

/**
 * A name-based example is only usable when it is compatible with the declared
 * schema type — a `boolean`-typed property named `status` must not get the
 * string 'active'. Numeric strings are converted for number schemas, scalars
 * are stringified for string schemas. Returns `undefined` when incompatible.
 */
export function coerceToSchema(value: unknown, schema: SchemaForCoercion): unknown | undefined {
  switch (schema.type) {
    case 'number':
    case 'integer': {
      let n: number | undefined;
      if (typeof value === 'number') n = value;
      else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Number(value);
      if (n === undefined) return undefined;
      if (schema.type === 'integer') n = Math.round(n);
      if (schema.minimum !== undefined && n < schema.minimum) n = schema.minimum;
      if (schema.maximum !== undefined && n > schema.maximum) n = schema.maximum;
      return n;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'string': {
      if (typeof value === 'boolean') return undefined;
      if (typeof value === 'object' && value !== null) return undefined;
      let str = String(value);
      if (schema.maxLength !== undefined && str.length > schema.maxLength) str = str.slice(0, schema.maxLength);
      // A guessed value must satisfy the property's own validation pattern.
      if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern).test(str)) return undefined;
        } catch {
          // unparsable pattern -> ignore
        }
      }
      return str;
    }
    default:
      return value;
  }
}
