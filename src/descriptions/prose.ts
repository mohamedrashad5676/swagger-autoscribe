// Prose normalization: turns word lists derived from identifiers into natural
// domain language. Everything here is generic vocabulary / grammar; nothing
// refers to a specific endpoint.

import { conventions } from './conventions';

const ACRONYMS: Record<string, string> = {
  id: 'ID', ids: 'IDs', url: 'URL', urls: 'URLs', uri: 'URI', jwt: 'JWT', api: 'API',
  ip: 'IP', uuid: 'UUID', sso: 'SSO', sms: 'SMS', html: 'HTML', json: 'JSON', csv: 'CSV', pdf: 'PDF',
  '2fa': 'two-factor authentication', mfa: 'multi-factor authentication', http: 'HTTP', rpc: 'RPC',
};

// Abbreviations that identifiers use but prose should spell out.
const EXPANSIONS: Record<string, string> = {
  f: 'first', l: 'last', msg: 'message', qty: 'quantity', desc: 'description', num: 'number',
  ts: 'timestamp', config: 'configuration', info: 'information', img: 'image', pwd: 'password', auth: 'authentication',
};

// Verb -> noun, used when a verb appears as a modifier ("account delete token").
const NOMINAL: Record<string, string> = {
  delete: 'deletion', create: 'creation', restore: 'restoration', remove: 'removal', update: 'update',
  activate: 'activation', deactivate: 'deactivation', enable: 'enablement', disable: 'disablement',
  verify: 'verification', invite: 'invitation', approve: 'approval', reject: 'rejection',
  cancel: 'cancellation', register: 'registration', assign: 'assignment', revoke: 'revocation',
  suspend: 'suspension', request: 'request', reset: 'reset', change: 'change', confirm: 'confirmation',
  move: 'move', regenerate: 'regeneration', login: 'login', logout: 'logout', refresh: 'refresh',
  grant: 'grant', resend: 'resend', send: 'sending', export: 'export', import: 'import',
};

// Irregular / needing-care past participles for passive phrasing.
const PARTICIPLES: Record<string, string> = {
  send: 'sent', set: 'set', add: 'added', grant: 'granted', release: 'released', reserve: 'reserved',
  create: 'created', delete: 'deleted', remove: 'removed', assign: 'assigned', revoke: 'revoked',
  update: 'updated', activate: 'activated', deactivate: 'deactivated', modify: 'modified',
  edit: 'edited', change: 'changed', restore: 'restored', transfer: 'transferred', invalidate: 'invalidated',
  verify: 'verified', generate: 'generated', rotate: 'rotated', publish: 'published', notify: 'notified',
  schedule: 'scheduled', cancel: 'cancelled', consume: 'consumed', enable: 'enabled', disable: 'disabled',
  approve: 'approved', reject: 'rejected', accept: 'accepted', move: 'moved', invite: 'invited',
  process: 'processed', record: 'recorded', handle: 'handled', lock: 'locked', unlock: 'unlocked',
};

export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .toLowerCase()
    .replace(/\b(\d+) ([a-z]{1,3})\b/g, '$1$2')
    .split(/\s+/)
    .filter(Boolean);
}

export function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function plural(word: string): string {
  if (/(ss|us)$/.test(word)) return `${word}es`;
  if (/s$/.test(word)) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

export const singularPhrase = (w: string[]): string[] =>
  w.length === 0 ? [] : [...w.slice(0, -1), singular(w[w.length - 1])];
export const pluralPhrase = (w: string[]): string[] =>
  w.length === 0 ? [] : [...w.slice(0, -1), plural(w[w.length - 1])];

export function participle(verb: string): string {
  const v = verb.toLowerCase();
  if (PARTICIPLES[v]) return PARTICIPLES[v];
  if (/e$/.test(v)) return `${v}d`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ied`;
  return `${v}ed`;
}

export const nominal = (verb: string): string | undefined => NOMINAL[verb.toLowerCase()];

// "refresh token" kept; "token token" / "membership member" collapsed.
function collapseStems(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (prev === w || (prev.startsWith(w) && w.length >= 4) || (w.startsWith(prev) && prev.length >= 4))) {
      if (w.length < prev.length) continue;
      out[out.length - 1] = w;
      continue;
    }
    out.push(w);
  }
  return out;
}

// Noun phrase for a resource / concept: acronyms, spelled-out abbreviations,
// deverbal modifiers ("account delete token" -> "account-deletion token") and
// verb-first compounds ("join code settings" -> "join-code settings").
export function nounPhrase(rawWords: string[], opts: { verbs?: ReadonlySet<string>; plain?: boolean } = {}): string {
  let words = rawWords.map((w, i) => (EXPANSIONS[w] && (i < rawWords.length - 1 || w === 'ts') ? EXPANSIONS[w] : w));
  words = collapseStems(words);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    const nom = NOMINAL[w];
    if (!isLast && nom && !opts.plain) {
      // modifier verb: "delete token" -> "deletion token"; after another noun the
      // pair is hyphenated ("account-deletion token")
      if (i > 0) {
        const prev = out.pop() ?? '';
        out.push(`${prev}-${nom}`);
      } else {
        out.push(nom);
      }
      continue;
    }
    out.push(w);
  }
  // verb-first compound with at least two more words: "join code settings"
  if (!opts.plain && words.length >= 3 && opts.verbs?.has(words[0]) && !NOMINAL[words[0]]?.endsWith('ion')) {
    out.splice(0, 2, `${out[0]}-${out[1]}`);
  }
  return out.map((w) => ACRONYMS[w] ?? conventions().acronyms[w] ?? conventions().properNouns[w] ?? w).join(' ');
}

// A hyphenated, entry-style label: "join_code.enabled" -> "join-code-enabled".
export function hyphenLabel(raw: string): string {
  return splitIdentifier(raw).map((w) => EXPANSIONS[w] ?? w).join('-');
}

export const capFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export const withPeriod = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

export function article(noun: string): 'a' | 'an' {
  return /^[aeiou]/i.test(noun) && !/^(uni|use|usa|usu|uti|one|eu)/i.test(noun) ? 'an' : 'a';
}

export function naturalList(items: string[], conjunction = 'and'): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

// Field label for a property name: "dateFormat" -> "date format",
// "isBasePlan" -> "base plan flag", "productId" -> "product ID",
// "permissionIds" -> "permission IDs", "f_name" -> "first name".
export function fieldLabel(name: string, kind?: string): string {
  const words = splitIdentifier(name);
  if (words.length === 0) return name;
  // "onReportFiles" -> "report files"
  if (words[0] === 'on' && words.length > 2) words.shift();
  // "startEndTime" -> "start and end time"; "totalSizeBytes" -> "total size in bytes".
  const pair = words.findIndex((w, i) => w === 'start' && words[i + 1] === 'end');
  if (pair >= 0) words.splice(pair + 1, 0, 'and');
  const last = words[words.length - 1];
  if (words.length > 2 && last === 'bytes') return `${nounPhrase(words.slice(0, -1), { plain: true })} in bytes`;
  if (words.length > 2 && last === 'percentage') return `percentage of ${nounPhrase(words.slice(0, -1), { plain: true })}`;
  if (words.length > 1 && words[words.length - 1] === 'at') words[words.length - 1] = 'time';
  if (kind === 'boolean' || /^(is|has)$/.test(words[0])) {
    const rest = /^(is|has)$/.test(words[0]) ? words.slice(1) : words;
    if (rest.length > 0) return `${nounPhrase(rest, { plain: true })} flag`;
  }
  return nounPhrase(words, { plain: true });
}

// Final polish applied to a whole description: canonical acronyms, doubled
// determiners and spacing.
export function polish(text: string): string {
  let out = text;
  for (const [k, v] of [...Object.entries(conventions().acronyms), ...Object.entries(ACRONYMS)]) {
    if (k === 'id' || k === 'ids' || k === '2fa' || k === 'mfa') continue;
    out = out.replace(new RegExp(`\\b${k}\\b`, 'gi'), v);
  }
  return out
    .replace(/\b2fa\b/gi, 'two-factor authentication')
    .replace(/\b(the|a|an) the\b/gi, (m) => m.split(' ')[1])
    .replace(/\bthe the\b/gi, 'the')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}
