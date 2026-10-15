// Business-fact model. Turns raw source facts (the handler, every service
// reached from it, entities and the generated OpenAPI request/response
// schemas) into the facts a documentation
// writer would state. Prose is produced by description-composer.ts.
//
// Rule: a fact is only emitted when a concrete piece of source proves it.
// Implementation details (HTTP verb, route, class/method names, return types,
// auth, permissions, helper/model calls) never reach the model.

import { canonicalWord, conventions, type DescriptionConventions } from './conventions';
import type { ChainStep } from './service-chain';
import type { EntityFacts } from './entity-facts';
import { dedupeEvidence, EVIDENCE, sameEvidence, type Evidence, type Fact } from './evidence';
import type { MethodSourceInfo, ThrownError, GuardCondition } from './method-facts';
import { assess, meets, observe, type Confidence, type ObservationContext } from './confidence';
import { decideDepth, type DepthDecision } from './depth';
import { detectConflicts, withdrawsClaim, type Assertion, type Conflict } from './conflicts';
import { classifyFailure, reachableFailures, type ConditionStrength, type Failure, type Reachability } from './error-reachability';
import type { FieldFact, ResponseFacts } from './schema-facts';
import {
  article, capFirst, fieldLabel, hyphenLabel, naturalList, nominal, nounPhrase, participle, plural,
  pluralPhrase, polish, singular, singularPhrase, splitIdentifier, withPeriod,
} from './prose';

export interface EndpointSourceInput {
  controllerClassName: string;
  methodName: string;
  httpMethod: string;
  // Handler first, then every service / backend method reached from it.
  steps: ChainStep[];
  // Served by the shared generic CRUD base classes.
  crud: boolean;
  entity?: EntityFacts;
  hasPagination: boolean;
  resourceName?: string;
  pathParams: string[];
  queryParams: string[];
  request: FieldFact[];
  response: ResponseFacts;
}

export type Kind = 'create' | 'update' | 'delete' | 'state' | 'action' | 'read' | 'list' | 'search';

export interface Effect {
  // Lemma of the business verb ("release").
  verb: string;
  // "the seat", "the ownership of the report file".
  object: string;
  // Source locations the effect was read from.
  evidence?: Evidence[];
}

export interface EndpointBusinessFacts {
  action: { lead: string; kind: Kind; lemma: string };
  resource: string;
  target: string;
  request: { required: string[]; optional: string[]; constraints: string[]; defaults: string[]; partial: boolean };
  ownerAssigned: boolean;
  initializations: string[];
  effects: Effect[];
  auditEntries: string[];
  events: string[];
  rules: string[];
  // The rules above with the operation-relevant failures that establish each.
  ruleFacts: RuleFact[];
  existence?: string;
  idempotent: boolean;
  lifecycle: string[];
  // "belongs to a product", "can have variants" (entity relations).
  relations: string[];
  // Past participles of the supported list options: filtered, searched, ...
  querying: string[];
  result?: { text: string; qualifier: string };
  response: { list: boolean; paginated: boolean; fields: string[]; related: string[] };
  // Every behavioural claim above with the evidence it rests on. A claim
  // without evidence is a defect (see `unsupportedClaims`).
  claims: Fact[];
  // Disagreements among the evidence about the same fact (see conflicts.ts),
  // including those that withdrew a claim.
  conflicts?: Conflict[];
  // Claims the semantic gates withdrew, and why (depth.ts reads them).
  withdrawn?: { kind: string; subject?: string; reason: 'low-confidence' | 'disputed' }[];
  // How much of the contract this evidence justifies describing (depth.ts).
  depth?: DepthDecision;
}

export interface Verb {
  lead: string;
  kind: Kind;
  // Intransitive verb: reads fine without an object ("Signs in using ...").
  bare?: boolean;
  // Object used when the name carries none.
  implicitObject?: (controllerNoun: string[]) => string;
}

const VERBS: Record<string, Verb> = {
  create: { lead: 'Creates', kind: 'create' },
  add: { lead: 'Adds', kind: 'create' },
  register: { lead: 'Registers', kind: 'create' },
  upload: { lead: 'Uploads', kind: 'create' },
  import: { lead: 'Imports', kind: 'create' },
  update: { lead: 'Updates', kind: 'update' },
  edit: { lead: 'Edits', kind: 'update' },
  modify: { lead: 'Modifies', kind: 'update' },
  set: { lead: 'Sets', kind: 'update' },
  change: { lead: 'Changes', kind: 'update' },
  rename: { lead: 'Renames', kind: 'update' },
  delete: { lead: 'Deletes', kind: 'delete' },
  remove: { lead: 'Removes', kind: 'delete' },
  enable: { lead: 'Enables', kind: 'state' },
  disable: { lead: 'Disables', kind: 'state' },
  activate: { lead: 'Activates', kind: 'state' },
  deactivate: { lead: 'Deactivates', kind: 'state' },
  suspend: { lead: 'Suspends', kind: 'state' },
  restore: { lead: 'Restores', kind: 'state' },
  archive: { lead: 'Archives', kind: 'state' },
  invite: { lead: 'Invites', kind: 'action' },
  accept: { lead: 'Accepts', kind: 'action' },
  reject: { lead: 'Rejects', kind: 'action' },
  approve: { lead: 'Approves', kind: 'action' },
  verify: { lead: 'Verifies', kind: 'action' },
  confirm: { lead: 'Confirms', kind: 'action' },
  validate: { lead: 'Validates', kind: 'action' },
  check: { lead: 'Checks', kind: 'action' },
  resend: { lead: 'Resends', kind: 'action' },
  send: { lead: 'Sends', kind: 'action' },
  request: { lead: 'Requests', kind: 'action' },
  reset: { lead: 'Resets', kind: 'action' },
  regenerate: { lead: 'Regenerates', kind: 'action' },
  cancel: { lead: 'Cancels', kind: 'action' },
  download: { lead: 'Downloads', kind: 'action' },
  export: { lead: 'Exports', kind: 'action' },
  join: { lead: 'Joins', kind: 'action' },
  leave: { lead: 'Leaves', kind: 'action' },
  assign: { lead: 'Assigns', kind: 'action' },
  revoke: { lead: 'Revokes', kind: 'action' },
  grant: { lead: 'Grants', kind: 'action' },
  toggle: { lead: 'Toggles', kind: 'action' },
  setup: { lead: 'Sets up', kind: 'action' },
  move: { lead: 'Moves', kind: 'action' },
  retry: { lead: 'Retries', kind: 'action' },
  access: { lead: 'Accesses', kind: 'action' },
  start: { lead: 'Starts', kind: 'action' },
  stop: { lead: 'Stops', kind: 'action' },
  handle: { lead: 'Processes', kind: 'action' },
  process: { lead: 'Processes', kind: 'action' },
  forgot: { lead: 'Starts the recovery of', kind: 'action' },
  login: { lead: 'Signs in', kind: 'action', bare: true },
  logout: { lead: 'Signs out', kind: 'action', bare: true },
  get: { lead: 'Retrieves', kind: 'read' },
  retrieve: { lead: 'Retrieves', kind: 'read' },
  fetch: { lead: 'Retrieves', kind: 'read' },
  find: { lead: 'Retrieves', kind: 'read' },
  list: { lead: 'Retrieves', kind: 'list' },
  search: { lead: 'Searches', kind: 'search' },
};
// Generic verbs plus any verbs the project registered.
const verbOf = (word: string | undefined): Verb | undefined => (word === undefined ? undefined : (VERBS[word] ?? conventions().verbs[word]));
let verbSetFor: { conv: DescriptionConventions; set: ReadonlySet<string> } | undefined;
const verbSet = (): ReadonlySet<string> => {
  const conv = conventions();
  if (verbSetFor?.conv !== conv) verbSetFor = { conv, set: new Set([...Object.keys(VERBS), ...Object.keys(conv.verbs)]) };
  return verbSetFor.set;
};

// Collaborator verbs that are a business side effect (not reads, validation,
// mapping or logging). `suffix` completes the object ("handle" -> "… event").
const SIDE_EFFECT_VERBS: Record<string, { lemma: string; suffix?: string }> = {
  send: { lemma: 'send' }, release: { lemma: 'release' }, reserve: { lemma: 'reserve' },
  issue: { lemma: 'issue' }, revoke: { lemma: 'revoke' }, invalidate: { lemma: 'invalidate' },
  notify: { lemma: 'notify' }, create: { lemma: 'create' }, add: { lemma: 'add' },
  remove: { lemma: 'remove' }, delete: { lemma: 'delete' }, assign: { lemma: 'assign' },
  grant: { lemma: 'grant' }, schedule: { lemma: 'schedule' }, enqueue: { lemma: 'enqueue' },
  sync: { lemma: 'synchronize' }, deactivate: { lemma: 'deactivate' }, activate: { lemma: 'activate' },
  cancel: { lemma: 'cancel' }, consume: { lemma: 'consume' }, transfer: { lemma: 'transfer' },
  verify: { lemma: 'verify' }, generate: { lemma: 'generate' }, rotate: { lemma: 'rotate' },
  lock: { lemma: 'lock' }, unlock: { lemma: 'unlock' },
  handle: { lemma: 'process', suffix: ' event' },
};
// Technical plumbing words dropped when a property name becomes a noun;
// persistence technology words come from the persistence adapter.
const INFRA_NOUNS = new Set(['client', 'logger', 'cache', 'config', 'connection', 'service', 'manager', 'helper', 'util', 'utils', 'api']);
const STOP_WORDS = new Set(['by', 'of', 'to', 'with', 'and', 'or', 'from', 'in']);
const OPPOSITES: [string, string][] = [
  ['reserve', 'release'], ['create', 'delete'], ['create', 'remove'], ['add', 'remove'],
  ['activate', 'deactivate'], ['grant', 'revoke'], ['assign', 'revoke'], ['lock', 'unlock'],
];

const KINDS_BY_HTTP: Record<string, Kind[]> = {
  get: ['read', 'list', 'search'],
  delete: ['delete', 'action', 'state'],
  put: ['update', 'state', 'action', 'create'],
  patch: ['update', 'state', 'action'],
};

const MUTATING: Kind[] = ['create', 'update', 'delete', 'state', 'action'];
const GENERIC_RETURN = new Set([
  'action', 'success', 'message', 'status', 'void', 'boolean', 'string',
  'number', 'object', 'any', 'unknown', 'empty', 'ok', 'promise',
]);
const RETURN_STRIP = new Set([
  'dto', 'response', 'resource', 'request', 'single', 'list', 'detail',
  'details', 'result', 'payload', 'item', 'management',
]);
const LAST_GENERIC = new Set(['action', 'success', 'message', 'result', 'response', 'ok']);
const MAX_LISTED_FIELDS = 8;
const MAX_EFFECTS = 4;
const MAX_RULES = 5;
const MAX_RULE_LENGTH = 110;

export { splitIdentifier as splitWords };
export { naturalList } from './prose';

interface ParsedName {
  verb: Verb;
  lemma: string;
  object: string[];
  criteria: string[];
  qualifier?: { prep: string; words: string[] };
  mine: boolean;
  all: boolean;
  bulk: boolean;
  deleted: boolean;
}

const PREPOSITIONS = ['to', 'from', 'for', 'in', 'of'];
const MINE_WORDS = ['my', 'me', 'mine', 'current', 'own'];

function parseName(name: string): ParsedName | undefined {
  const words = splitIdentifier(name);
  let bulk = false;
  let permanent = false;
  while (['bulk', 'permanent', 'permanently', 'public'].includes(words[0])) {
    if (words[0] === 'bulk') bulk = true;
    else if (words[0] !== 'public') permanent = true;
    words.shift();
  }
  const [first, ...restAll] = words;
  let verb = first ? verbOf(first) : undefined;
  if (!verb) return undefined;
  let lemma = first;
  let rest = restAll;
  // getOrCreate -> "Retrieves or creates"
  if (rest[0] === 'or' && verbOf(rest[1])) {
    verb = { lead: `${verb.lead} or ${verbOf(rest[1])!.lead.toLowerCase()}`, kind: 'action' };
    lemma = rest[1];
    rest = rest.slice(2);
  }
  if (permanent) verb = { ...verb, lead: `Permanently ${verb.lead.toLowerCase()}` };

  const byAt = rest.indexOf('by');
  const prepAt = rest.findIndex((w, i) => i > 0 && PREPOSITIONS.includes(w));
  const cut = [byAt, prepAt].filter((i) => i >= 0).sort((x, y) => x - y)[0];
  const objectRaw = cut === undefined ? rest : rest.slice(0, cut);
  const tail = cut === undefined ? [] : rest.slice(cut);
  const criteria = tail[0] === 'by' ? tail.slice(1).filter((w) => w !== 'id') : [];
  const qualifier =
    tail.length > 1 && tail[0] !== 'by'
      ? { prep: tail[0], words: tail.slice(1).filter((w) => w !== 'id') }
      : undefined;
  const mine = objectRaw.some((w) => MINE_WORDS.includes(w));
  const all = objectRaw.includes('all');
  const deletedWords = ['deleted', ...conventions().deletedViewWords];
  const deleted = objectRaw.some((w) => deletedWords.includes(w));
  const object = objectRaw.filter((w) => ![...MINE_WORDS, 'all', 'one', ...deletedWords].includes(w));
  // "member details" identifies the same record as "member".
  while (object.length > 1 && ['details', 'detail', 'info'].includes(object[object.length - 1])) object.pop();
  return { verb, lemma, object, criteria, qualifier, mine, all, bulk, deleted };
}

const evidenceIn = (step: ChainStep, kind: string, match: (d: Record<string, unknown>) => boolean = () => true): Evidence[] =>
  step.info.evidence.filter((e) => e.kind === kind && match(e.details ?? {}));

// A creator that stores the caller under a property named for ownership.
const OWNERSHIP = /owner/i;
// Names of calls that supply initial values for a created record.
const INITIALIZER = /^generate[A-Z]|^(?:resolve|get|apply)Default[A-Z]/;

const lastSegment = (call: string): string => call.split('.').pop() ?? call;
const uniq = <T>(list: T[]): T[] => Array.from(new Set(list));
const handlerOf = (input: EndpointSourceInput): MethodSourceInfo => input.steps[0].info;
const lastWord = (words: string[]): string => words[words.length - 1] ?? '';

// The implementation wins: the method name is used first, but when it is
// absent, or contradicts the HTTP method, the service / RPC names decide.
function resolveIntent(input: EndpointSourceInput): ParsedName | undefined {
  const allowed = KINDS_BY_HTTP[input.httpMethod.toLowerCase()];
  const fits = (p: ParsedName): boolean => !allowed || allowed.includes(p.verb.kind);

  const own = parseName(input.methodName);
  if (own && fits(own)) return own;

  const implNames = [
    ...handlerOf(input).serviceCalls.map(lastSegment),
    ...uniq(input.steps.flatMap((s) => s.info.rpcCalls)),
  ];
  for (const n of implNames) {
    const p = parseName(n);
    if (p && fits(p)) return { ...p, mine: p.mine || (own?.mine ?? false) };
  }
  return undefined;
}

export function controllerNoun(className: string): string[] {
  return singularPhrase(splitIdentifier(className.replace(/Controller$/, '')));
}

function paramEntity(param: string, ctrlNoun: string[]): string[] {
  const words = splitIdentifier(param);
  if (words[words.length - 1] === 'id') words.pop();
  return words.length > 0 ? words : ctrlNoun;
}

function returnNoun(input: EndpointSourceInput): { text: string } | undefined {
  const raw = input.resourceName ?? handlerOf(input).returnType;
  if (!raw) return undefined;
  const m = /^(?:Promise<)?\s*([A-Za-z_]\w*)/.exec(raw.trim());
  if (!m) return undefined;
  const words = splitIdentifier(m[1]);
  const detail = words.includes('detail') || words.includes('details');
  const single = detail || words.includes('single');
  let rest = words.filter((w) => !RETURN_STRIP.has(w));
  if (rest.length === 0 || rest.every((w) => GENERIC_RETURN.has(w)) || LAST_GENERIC.has(lastWord(rest))) return undefined;
  // "VerifyOtpResponse" / "RegisterResponse" name an operation, not data.
  if (verbOf(rest[0])) return undefined;
  if (single) rest = singularPhrase(rest);
  return { text: `${nounPhrase(rest, { verbs: verbSet() })}${detail ? ' details' : ''}` };
}

// ---- request ---------------------------------------------------------------

const CONSTRAINT_LABELS: Record<string, string> = {
  enum: 'must each be one of the supported values',
  range: 'must each fall within the supported range',
  format: 'must each match the expected format',
};

// One compact sentence per constraint kind; the schema keeps the details.
function constraintSentences(fields: FieldFact[]): string[] {
  const by = (c: string): string[] => fields.filter((f) => f.constraints.includes(c as never)).map((f) => f.label);
  const out: string[] = [];
  const enums = by('enum').slice(0, 4);
  if (enums.length === 1) out.push(`the ${enums[0]} must be one of the supported values`);
  else if (enums.length > 1) out.push(`the ${naturalList(enums)} ${CONSTRAINT_LABELS.enum}`);
  const emails = fields.filter((f) => f.constraints.includes('email'));
  for (const e of emails.filter((x) => x.type === 'array')) out.push(`each entry in the ${e.label} must be a valid email address`);
  const singleEmails = emails.filter((x) => x.type !== 'array').map((x) => x.label);
  const pluralEmails = singleEmails.filter((l) => singular(l.split(' ').pop() ?? '') !== (l.split(' ').pop() ?? ''));
  for (const l of pluralEmails) out.push(`each of the ${l} must be a valid email address`);
  const oneEmails = singleEmails.filter((l) => !pluralEmails.includes(l));
  if (oneEmails.length > 0) out.push(`the ${naturalList(oneEmails)} must be a valid email address`);
  const ranges = by('range');
  if (ranges.length > 0) out.push(`the ${naturalList(ranges)} ${ranges.length > 1 ? CONSTRAINT_LABELS.range : 'must fall within the supported range'}`);
  const formats = by('format');
  if (formats.length > 0) out.push(`the ${naturalList(formats.slice(0, 3))} ${formats.length > 1 ? CONSTRAINT_LABELS.format : 'must match the expected format'}`);
  return out.slice(0, 3);
}

// The entity describes the endpoint's resource only when they name the same noun.
function entityFits(input: EndpointSourceInput, resource: string): boolean {
  if (!input.entity) return false;
  if (input.crud) return true;
  const last = (t: string): string => singular(t.split(' ').pop() ?? '');
  return last(splitIdentifier(input.entity.className.replace(/(Entity|Document|Schema)$/, '')).join(' ')) === last(resource);
}

function defaultsOf(input: EndpointSourceInput, resource: string): string[] {
  const entity = input.entity;
  if (!entity || !entityFits(input, resource)) return [];
  const supplied = new Set(input.request.filter((f) => f.required).map((f) => f.name));
  const out: string[] = [];
  for (const f of entity.fields) {
    if (f.defaultValue === undefined || supplied.has(f.name) || f.relation) continue;
    const words = splitIdentifier(f.name);
    const flag = /^(is|has)$/.test(words[0]);
    const label = nounPhrase(flag ? words.slice(1) : words);
    if (f.defaultValue === 'true' || f.defaultValue === 'false') {
      const positive = f.defaultValue === 'true';
      out.push(`${positive ? 'is' : 'is not'} ${flag ? 'marked as ' : ''}${label}`);
    } else if (/^[A-Z]\w*\.([A-Z][A-Z_]*)$/.test(f.defaultValue)) {
      const member = splitIdentifier(f.defaultValue.split('.')[1]).join(' ');
      out.push(`has its ${nounPhrase(words)} set to ${member}`);
    }
  }
  return out.slice(0, 3).map((p) => `${p}`).filter((p) => p.length > 0 && resource.length > 0);
}

// ---- rules ----------------------------------------------------------------

const lowerFirstChar = (s: string): string => (/^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

// "Cannot modify account owner" -> "the account owner cannot be modified".
function passiveRule(verb: string, objectRaw: string): string {
  const object = /^(the|a|an|another|any)\s/i.test(objectRaw) ? lowerFirstChar(objectRaw) : `the ${objectRaw}`;
  return `${object} cannot be ${participle(verb)}`;
}

// "report must be soft-deleted" -> "the report must be soft-deleted".
function withDeterminer(clause: string): string {
  return /^(the|a|an|this|that|each|every|any|no|only|at least|both|all|one)\b/i.test(clause) ? clause : `the ${clause}`;
}

// Turns a thrown business error into the rule it enforces (lower-case clause,
// no final period). Only messages that state a rule are kept; plain
// "not found", identifiers and validation noise are dropped.
export function ruleClauseFromThrow(t: ThrownError): string | undefined {
  const msg = t.message
    ?.split(/;|\. /)[0]
    .trim()
    .replace(/\byou do not\b/gi, 'the authenticated user does not')
    .replace(/\byou\b/gi, 'the authenticated user');
  if (!msg || msg.length > MAX_RULE_LENGTH || /\$\{/.test(msg) || /\be\.g\b|[,(]$/i.test(msg)) return undefined;
  if (t.status === 404 || /not found$/i.test(msg)) return undefined;
  if (/[_"'`*—:]|[a-z][A-Z]|ObjectId|\b[A-Z]{5,}\b/.test(msg)) return undefined;
  if (/[A-Z][a-z]+[A-Z][a-z]+/.test(msg)) return undefined;
  let m: RegExpExecArray | null;
  if ((m = /^invalid or expired ([\w ]{3,40})$/i.exec(msg))) return `the ${lowerFirstChar(m[1])} must be valid and not expired`;
  if ((m = /^(.+?) (?:expired|has expired) or not (?:initiated|started|completed)\b/i.exec(msg))) {
    return `the ${lowerFirstChar(m[1])} must have been initiated and must not have expired`;
  }
  if ((m = /^invalid ([\w ]{3,40})$/i.exec(msg))) return `the ${lowerFirstChar(m[1])} must be valid`;
  if ((m = /^(?:the authenticated user) (must|cannot) (.+)$/i.exec(msg))) {
    return `the authenticated user ${m[1].toLowerCase()} ${m[2]}`;
  }
  if ((m = /^(.+?) (?:is|are) required (to|for|when|unless) (.+)$/i.exec(msg))) {
    return `${lowerFirstChar(m[1])} is required ${m[2]} ${m[3]}`;
  }
  if (/^only /i.test(msg)) return lowerFirstChar(msg);
  if ((m = /^(?:cannot|can not|can't|unable to) (\w+) (.+)$/i.exec(msg))) return passiveRule(m[1], m[2]);
  if ((m = /^(.+?) (?:is|are|was) already (.+)$/i.exec(msg))) return withDeterminer(`${lowerFirstChar(m[1])} must not already be ${m[2]}`);
  if ((m = /^(.+?) already exists?$/i.exec(msg))) return withDeterminer(`${lowerFirstChar(m[1])} must not already exist`);
  if ((m = /^(.+?) has expired\b/i.exec(msg))) return withDeterminer(`${lowerFirstChar(m[1])} must not have expired`);
  if ((m = /^(.+?) (?:is|are) not (?!allowed|found|available)(.+)$/i.exec(msg))) return withDeterminer(`${lowerFirstChar(m[1])} must be ${m[2]}`);
  if (/^(.+?) (?:is|are) not allowed\b/i.test(msg)) return lowerFirstChar(msg);
  if (/^must /i.test(msg) || / must /i.test(msg)) return withDeterminer(lowerFirstChar(msg));
  if (/^at least one .+ (?:must|is) /i.test(msg)) return lowerFirstChar(msg);
  return undefined;
}

// Kept for callers that want a standalone sentence.
export function ruleFromThrow(t: ThrownError): string | undefined {
  const clause = ruleClauseFromThrow(t);
  return clause ? polish(withPeriod(capFirst(clause))) : undefined;
}

// A guard `if (<cond>) throw ...` whose message was not usable still states a
// rule when the condition compares / tests a state.
export function ruleClauseFromGuard(g: GuardCondition): string | undefined {
  const cond = g.cond.replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  const subject = (path: string): string => nounPhrase(splitIdentifier(path.split('.')[0].replace(/^(this|req|request)$/, '')));
  if ((m = /^([\w.]+)\.(\w+) !== [A-Z]\w*\.([A-Z][A-Z_]*)$/.exec(cond))) {
    return `the ${subject(m[1])} ${nounPhrase(splitIdentifier(m[2]))} must be ${splitIdentifier(m[3]).join(' ')}`;
  }
  if ((m = /^([\w.]+)\.(\w+) === [A-Z]\w*\.([A-Z][A-Z_]*)$/.exec(cond))) {
    return `the ${subject(m[1])} ${nounPhrase(splitIdentifier(m[2]))} must not be ${splitIdentifier(m[3]).join(' ')}`;
  }
  if ((m = /^!([\w.]+)\.(\w*(?:Enabled|Active|Verified))$/.exec(cond))) {
    const word = splitIdentifier(m[2]).slice(-1)[0];
    return `the ${subject(m[1])} must be ${word}`;
  }
  const field = conventions().softDeleteField;
  if (field) {
    if ((m = new RegExp(`^([\\w.]+)\\.${field}$`).exec(cond))) return `the ${subject(m[1])} must not be deleted`;
    if ((m = new RegExp(`^!([\\w.]+)\\.${field}$`).exec(cond))) return `the ${subject(m[1])} must be deleted`;
  }
  return undefined;
}

// Rules about the same subject read as one: "the token must be valid and not
// expired", "the token must not have expired" -> a single clause without repeats.
export function mergeRules(clauses: string[]): string[] {
  const bySubject = new Map<string, string[]>();
  const order: (string | { subject: string })[] = [];
  for (const c of clauses) {
    const m = /^(.+?) must ((?:not )?(?:be|have)\b.*)$/.exec(c);
    if (!m || /^(only|the authenticated user)\b/.test(c)) {
      order.push(c);
      continue;
    }
    const preds = m[2]
      .split(/ and (?:must )?(?=not\b|be\b|have\b)/)
      .map((x) => x.replace(/^not (?:have|be) expired$/, 'not expired').replace(/^must /, ''));
    if (!bySubject.has(m[1])) {
      bySubject.set(m[1], []);
      order.push({ subject: m[1] });
    }
    const list = bySubject.get(m[1]) as string[];
    for (const p of preds) if (!list.includes(p)) list.push(p);
  }
  return order.map((o) => {
    if (typeof o === 'string') return o;
    const preds = (bySubject.get(o.subject) as string[])
      .filter((p, _i, all) => !all.some((q) => q !== p && q.startsWith(`${p} `)))
      .sort((a, b) => Number(a.startsWith('not')) - Number(b.startsWith('not')))
      .map((p, i, all) => (all.length === 1 && p === 'not expired' ? 'not have expired' : p));
    return `${o.subject} must ${naturalList(preds)}`;
  });
}

// A not-found failure supports an existence requirement only when it is relevant
// to this operation AND its source condition tests for absence (`if (!x)`,
// `x === null`, an empty lookup). A bare or conditionless not-found throw does
// not establish what must exist.
const ABSENCE = /^!(?!=)|(?:===?)\s*(?:null|undefined)\b|\.length\s*===?\s*0\b/;
function relevantNotFound(steps: ChainStep[]): Failure[] {
  return reachableFailures(steps).filter(
    (fl) => fl.relevant && meets(fl.confidence, 'medium') && fl.consequence.status === 404 && fl.condition.strength === 'observed' && ABSENCE.test(fl.condition.text ?? ''),
  );
}

// A business rule with the failures that establish it. `reachability` is the
// strongest relation among them (direct > indirect > shared).
export interface RuleFact {
  rule: string;
  failures: Failure[];
  reachability: Reachability;
  // Strongest known trigger: a condition read from source beats a branch beats none.
  condition: ConditionStrength;
  // The strongest single failure behind the rule (agreement does not add up).
  confidence: Confidence;
}

const REACH_RANK: Reachability[] = ['direct', 'indirect', 'shared', 'infrastructure'];
const CONDITION_RANK: ConditionStrength[] = ['observed', 'branch', 'none'];

// The strongest single confidence (levels are never added together).
const LEVELS = ['high', 'medium', 'low'] as const;
export const bestOf = (cs: Confidence[]): Confidence =>
  cs.slice().sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))[0] ?? assess([]);

function ruleFactsOf(steps: ChainStep[]): RuleFact[] {
  const sources: { clause: string; failure: Failure }[] = [];
  const add = (clause: string | undefined, failure: Failure): void => {
    // Only failures relevant to this operation can state one of its rules.
    // Only failures the source proves strongly enough can state a rule.
    if (!failure.relevant || !meets(failure.confidence, 'medium')) return;
    if (clause && !sources.some((s) => s.clause === clause)) sources.push({ clause, failure });
    else if (clause) sources.find((s) => s.clause === clause)?.failure.evidence.push(...failure.evidence);
  };
  for (const step of steps) {
    for (const t of step.info.throws) {
      const guard = step.info.guards.find((g) => g.thrown.type === t.type && g.thrown.message === t.message);
      add(ruleClauseFromThrow(t), classifyFailure(step, t, guard));
    }
    for (const g of step.info.guards) {
      if (!ruleClauseFromThrow(g.thrown)) add(ruleClauseFromGuard(g), classifyFailure(step, g.thrown, g));
    }
  }
  const rank = (r: string): number => (/^only|cannot be/i.test(r) ? 0 : 1);
  return mergeRules(sources.map((s) => s.clause))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .slice(0, MAX_RULES)
    .map(({ r }) => {
      const subject = /^(.+?) must /.exec(r)?.[1];
      const failures = sources
        .filter((s) => s.clause === r || (subject !== undefined && !/^(only|the authenticated user)\b/.test(s.clause) && s.clause.startsWith(`${subject} must `)))
        .map((s) => s.failure);
      const by = <T,>(order: T[], pick: (f: Failure) => T): T => failures.map(pick).sort((x, y) => order.indexOf(x) - order.indexOf(y))[0];
      return {
        rule: r,
        failures,
        reachability: failures.length > 0 ? by(REACH_RANK, (f) => f.reach) : 'indirect',
        condition: failures.length > 0 ? by(CONDITION_RANK, (f) => f.condition.strength) : 'none',
        confidence: bestOf(failures.map((f) => f.confidence)),
      };
    });
}

// ---- side effects / state ---------------------------------------------------

const isDataAccess = (prop: string): boolean => conventions().dataAccessSuffixes.some((x) => prop.toLowerCase().endsWith(x));

function nounOfProp(prop: string): string[] {
  const words = splitIdentifier(prop).filter((w) => !INFRA_NOUNS.has(w) && !conventions().technologyWords.includes(w));
  return singularPhrase(words);
}

function sideEffectOfCall(call: string): Effect | undefined {
  const [, prop, method] = call.split('.');
  const parsed = splitIdentifier(method);
  const entry = parsed[0] ? SIDE_EFFECT_VERBS[parsed[0]] : undefined;
  if (!entry || /cache|log|metric|audit/i.test(`${prop}${method}`)) return undefined;
  if (isDataAccess(prop)) return undefined;
  // token plumbing of an external API client is not a business effect
  if (/client$/i.test(prop) && ['generate', 'verify'].includes(parsed[0])) return undefined;
  const propNoun = nounOfProp(prop);

  let methodObject = parsed.slice(1);
  // "revokeAllForUser": the object is "all <prop noun>"
  const stopAt = methodObject.findIndex((w) => STOP_WORDS.has(w) || w === 'for');
  const qualifier = stopAt >= 0 ? methodObject.slice(stopAt) : [];
  if (stopAt >= 0) methodObject = methodObject.slice(0, stopAt);
  if (methodObject.length === 1 && methodObject[0] === 'all' && propNoun.length > 0) {
    methodObject = ['all', ...pluralPhrase(propNoun)];
  } else if (methodObject.includes('and') || methodObject.includes('all')) {
    return undefined;
  }
  const object = methodObject.length > 0 ? methodObject : propNoun;
  if (object.length === 0) return undefined;
  const util = /(util|utils|helper)$/i.test(prop);
  // "ownership of the report file": only a single abstract word needs its owner.
  const overlaps = propNoun.some((w) => methodObject.some((m) => singular(m) === singular(w)));
  const owner =
    methodObject.length === 1 && propNoun.length > 1 && !util && !overlaps
      ? ` of the ${nounPhrase(propNoun)}`
      : '';
  const forWho = qualifier[0] === 'for' && qualifier.length > 1 ? ` for the ${nounPhrase(qualifier.slice(1))}` : '';
  const head = nounPhrase(object, { verbs: verbSet() });
  return {
    verb: entry.lemma,
    object: `${head.startsWith('all ') ? '' : 'the '}${head}${entry.suffix ?? ''}${owner}${forWho}`,
  };
}

const isReadStep = (step: ChainStep): boolean => {
  const kind = parseName(step.methodName)?.verb.kind;
  return kind === 'read' || kind === 'list' || kind === 'search';
};

function effectsOf(
  steps: ChainStep[],
  primary: ParsedName,
  resource: string,
  entities: string[],
): { effects: Effect[]; auditEntries: string[]; events: string[] } {
  const found: Effect[] = [];
  const targets = new Set([resource, ...entities].map((e) => singular(lastWord(e.split(' ')))));
  const add = (e: Effect): void => {
    const nounOfObject = singular(lastWord(e.object.replace(/ of the .*$/, '').replace(/ for the .*$/, '').split(' ')));
    const primaryLemma = SIDE_EFFECT_VERBS[primary.lemma]?.lemma ?? primary.lemma;
    if ((e.verb === primaryLemma && !e.object.endsWith(' event')) || targets.has(nounOfObject) || nounOfObject === primary.lemma) return;
    // an object contained in an already-listed one is the same fact, said shorter
    const norm = (o: string): string =>
      o.replace(/ (of|for) the .*$/, '').replace(/^(the|all) /, '').split(' ').map(singular).join(' ');
    const clash = found.findIndex(
      (f) => f.verb === e.verb && (norm(f.object).includes(norm(e.object)) || norm(e.object).includes(norm(f.object))),
    );
    if (clash >= 0) {
      if (e.object.length > found[clash].object.length) found[clash] = e;
      return;
    }
    // "the member of the user account" within the user account's own operation: the scope already says it
    const scoped = [resource, ...entities].map((x) => `of the ${x}`);
    const trimmed = scoped.some((x) => e.object.endsWith(x)) ? e.object.replace(/ of the [^,]+$/, '') : e.object;
    const clean: Effect = { ...e, object: trimmed };
    if (!found.some((f) => f.object === clean.object)) found.push(clean);
  };
  for (const step of steps) {
    if (isReadStep(step)) continue;
    for (const call of step.info.serviceCalls) {
      const e = sideEffectOfCall(call);
      if (e) add({ ...e, evidence: evidenceIn(step, EVIDENCE.serviceCall, (d) => d.call === call) });
    }
    for (const w of step.info.writes) {
      if (/aggregate|audit|log/i.test(w.receiver)) continue;
      if (!isDataAccess(w.receiver)) continue;
      const noun = nounOfProp(w.receiver).join(' ');
      if (!noun) continue;
      const evidence = evidenceIn(step, EVIDENCE.persistenceWrite, (d) => d.receiver === w.receiver && d.op === w.op);
      if (/^(create|insertMany|insertOne|save)$/.test(w.op)) add({ verb: 'create', object: `the ${noun}`, evidence });
      else if (/^(delete|remove|find\w*Delete)/.test(w.op)) add({ verb: 'remove', object: `the ${noun}`, evidence });
    }
  }
  // Opposing actions on the same object come from different branches (e.g. a
  // rollback); keep only the first, which is the main path.
  const kept = found.filter(
    (e, i) =>
      !OPPOSITES.some(([a, b]) =>
        [[a, b], [b, a]].some(([x, y]) => e.verb === x && found.slice(0, i).some((f) => f.verb === y && f.object === e.object)),
      ),
  );
  const events: string[] = [];
  const auditEntries: string[] = [];
  for (const step of steps) {
    if (isReadStep(step)) continue;
    for (const ev of step.info.emitted) events.push(hyphenLabel(ev));
  }
  for (const step of steps) for (const a of step.info.auditActions) auditEntries.push(hyphenLabel(a));
  return { effects: kept.slice(0, MAX_EFFECTS), auditEntries: uniq(auditEntries).slice(0, 2), events: uniq(events).slice(0, 2) };
}

function stateChangesOf(steps: ChainStep[], kind: Kind): Effect[] {
  const out: Effect[] = [];
  if (kind === 'delete' || kind === 'read' || kind === 'list') return out;
  for (const step of steps) {
    for (const w of step.info.writes) {
      for (const [field, value] of Object.entries(w.set)) {
        const m = /^[A-Z]\w*\.([A-Z][A-Z_]*)$/.exec(value);
        if (m && /^(status|state)$/i.test(field)) {
          out.push({
            verb: 'set',
            object: `the ${splitIdentifier(field).join(' ')} to ${splitIdentifier(m[1]).join(' ')}`,
            evidence: evidenceIn(step, EVIDENCE.persistenceWrite, (d) => d.receiver === w.receiver && d.op === w.op),
          });
        }
      }
    }
  }
  return out.slice(0, 1);
}

function initializationsOf(steps: ChainStep[]): string[] {
  const names = steps.flatMap((s) => [...s.info.plainCalls, ...s.info.serviceCalls.map(lastSegment), ...s.info.sameClassCalls]);
  const out: string[] = [];
  for (const n of names) {
    let m: RegExpExecArray | null;
    if ((m = /^generate([A-Z]\w+)$/.exec(n))) out.push(`a generated ${nounPhrase(splitIdentifier(m[1]))}`);
    else if ((m = /^(?:resolve|get|apply)Default([A-Z]\w+)$/.exec(n))) out.push(`default ${nounPhrase(splitIdentifier(m[1]))}`);
  }
  return uniq(out);
}

// ---- main ---------------------------------------------------------------------

// Booleans read better grouped: "name, type, and active and base plan flags".
function fieldLabels(fields: FieldFact[], resource = ''): string[] {
  const flags = fields.filter((f) => f.type === 'boolean').map((f) => f.label.replace(/ flag$/, ''));
  // A field named like its own resource ("comment" on a comment) is its text.
  const others = fields.filter((f) => f.type !== 'boolean').map((f) => (f.label === resource && f.type === 'string' ? `${f.label} text` : f.label));
  return flags.length > 0 ? [...others, `${naturalList(flags)} ${flags.length > 1 ? 'flags' : 'flag'}`] : others;
}

export function deriveBusinessFacts(input: EndpointSourceInput): EndpointBusinessFacts | undefined {
  const ctrlNoun = controllerNoun(input.controllerClassName);
  const intent = resolveIntent(input);
  if (!intent) return undefined;

  const handler = handlerOf(input);
  let kind: Kind = intent.verb.kind;
  if ((intent.all || intent.deleted) && kind === 'read') kind = 'list';
  const verb: Verb = { ...intent.verb, kind };
  let objectWords = intent.object;
  const originalPlural = objectWords.length > 0 && singular(lastWord(objectWords)) !== lastWord(objectWords);
  const defaulted = objectWords.length === 0;

  if (intent.deleted) objectWords = ['deleted', ...pluralPhrase(ctrlNoun)];
  else if (defaulted) objectWords = verb.implicitObject ? [] : ctrlNoun;

  // A bare `id` is only meaningful alone, on a record-level operation.
  const recordLevel = ['read', 'update', 'delete', 'state', 'action'].includes(kind);
  const idParams =
    input.pathParams.length > 1 || !recordLevel
      ? input.pathParams.filter((p) => p !== 'id')
      : input.pathParams;
  const entities = idParams
    .filter((p) => !/(token|code|key)$/i.test(p))
    .map((p) => paramEntity(p, ctrlNoun));

  // The object is "x" in a controller about "<..> x": use the full resource
  // name; a single unrelated word is qualified with the controller noun.
  const ctrlLast = singular(lastWord(ctrlNoun));
  const identifiedByParam = entities.some((e) => singular(lastWord(e)) === ctrlLast);
  if (!intent.deleted && !defaulted && objectWords.length === 1 && ctrlNoun.length > 0) {
    const w = singular(objectWords[0]);
    if (w === ctrlLast && ctrlNoun.length > 1) objectWords = originalPlural ? pluralPhrase(ctrlNoun) : ctrlNoun;
    else if (w !== ctrlLast && ctrlNoun.length > 1 && !identifiedByParam && kind !== 'create' && kind !== 'list' && !ctrlNoun.includes(w)) {
      objectWords = [...ctrlNoun, objectWords[0]];
    }
  }

  // e.g. "findUserReportFiles": files of the authenticated user.
  let mine = intent.mine && handler.usesAuthUser;
  if (!mine && handler.usesAuthUser && !defaulted && objectWords[0] === 'user' && objectWords.length > 1) {
    mine = true;
    objectWords = objectWords.slice(1);
  }
  // Own-profile style endpoints: no identifier in the route, handler acts on the caller.
  if (!mine && handler.usesAuthUser && input.pathParams.length === 0 && ['read', 'update'].includes(kind) && !defaulted && !intent.deleted) {
    mine = true;
  }

  const resource = nounPhrase(objectWords, { verbs: verbSet() });
  const used = new Set<number>();
  const findEntity = (words: string[]): number => {
    const key = singular(lastWord(words));
    const keys = new Set(words.map((w) => singular(w)));
    return key === ''
      ? -1
      : entities.findIndex((e, i) => {
          if (used.has(i)) return false;
          const last = canonicalWord(singular(lastWord(e)));
          return last === canonicalWord(key) || (e.length === 1 && keys.has(singular(lastWord(e))));
        });
  };

  const matchedIdx = mine || verb.bare || (kind === 'create' && !intent.qualifier) || objectWords.length === 0 ? -1 : findEntity(objectWords);
  if (matchedIdx >= 0) used.add(matchedIdx);

  let qualifierText = '';
  if (intent.qualifier && intent.qualifier.words.length > 0) {
    const q = singularPhrase(intent.qualifier.words);
    const qi = findEntity(q);
    if (qi >= 0) used.add(qi);
    qualifierText = ` ${intent.qualifier.prep} the ${qi >= 0 ? 'specified ' : ''}${nounPhrase(q)}`;
  }
  const parents = entities.filter((_, i) => !used.has(i));
  const parentText = [...parents].reverse().map((e) => `the specified ${nounPhrase(e)}`).join(' in ');

  let head: string;
  let prep = 'for';
  const pluralObject = nounPhrase(pluralPhrase(objectWords), { verbs: verbSet() });
  if (verb.implicitObject && (defaulted || objectWords.length === 0)) {
    head = verb.implicitObject(ctrlNoun);
  } else if (verb.bare && defaulted) {
    head = '';
  } else if (kind === 'list') {
    head = `a ${input.hasPagination || input.response.paginated ? 'paginated ' : ''}list of ${pluralObject}`;
    prep = 'in';
  } else if (kind === 'search') {
    head = pluralObject;
    prep = 'in';
  } else if (mine) {
    head = `the authenticated user's ${resource}`;
  } else if (matchedIdx >= 0) {
    head = `the specified ${resource}`;
    prep = 'in';
  } else if (kind === 'create') {
    const isPlural = singular(lastWord(objectWords)) !== lastWord(objectWords);
    head = isPlural ? `new ${resource}` : `a new ${resource}`;
    prep = 'in';
  } else {
    head = `the ${resource}`;
    prep = defaulted ? 'in' : 'for';
  }
  if (intent.criteria.length > 0) head += ` by ${nounPhrase(intent.criteria)}`;
  head += qualifierText;
  if (kind === 'list' && handler.usesAuthUser) head += ' for the authenticated user';
  // The handler acts on the caller's own identity and the route names no other record.
  if (['action', 'state', 'delete'].includes(kind) && handler.usesAuthUser && parents.length === 0 && matchedIdx < 0 && !mine && !verb.bare) {
    head += ' for the authenticated user';
  }
  if (intent.bulk) head += ' in bulk';
  const target = parentText ? `${head} ${prep} ${parentText}`.trim() : head;

  const mutating = MUTATING.includes(kind);
  const ownerAssigned = mutating && handler.authUserProps.some((p) => OWNERSHIP.test(p)) && kind === 'create';

  let result: EndpointBusinessFacts['result'];
  const ret = returnNoun(input);
  if (ret && mutating && kind !== 'delete') {
    const qualifier = kind === 'create' ? 'newly created ' : kind === 'update' || kind === 'state' ? 'updated ' : '';
    result = { text: ret.text, qualifier };
  }

  const required = input.request.filter((f) => f.required && f.name !== 'id');
  const optional = input.request.filter((f) => !f.required && f.name !== 'id');
  const takesInput = ['create', 'update', 'action'].includes(kind) && input.request.length > 0;
  const requestFacts: EndpointBusinessFacts['request'] = {
    required: takesInput ? fieldLabels(required, resource).slice(0, MAX_LISTED_FIELDS) : [],
    optional: takesInput ? fieldLabels(optional, resource).slice(0, MAX_LISTED_FIELDS) : [],
    constraints: takesInput ? constraintSentences(input.request) : [],
    defaults: kind === 'create' ? defaultsOf(input, resource) : [],
    // Partial-update semantics need merge evidence in the source, never the HTTP method alone.
    partial: takesInput && kind === 'update' && required.length === 0 && input.steps.some((st) => st.info.mergesInput),
  };
  const unique = input.entity && entityFits(input, resource)
    ? input.entity.fields.filter((f) => f.unique && input.request.some((r) => r.name === f.name)).map((f) => fieldLabel(f.name))
    : [];
  if (takesInput && unique.length > 0) requestFacts.constraints.push(`the ${naturalList(unique)} must be unique`);

  const ruleFacts = mutating ? ruleFactsOf(input.steps.filter((st, i) => i === 0 || !isReadStep(st))) : [];
  const idempotent = mutating && input.steps.some((s) => s.info.idempotent);
  const fx = mutating
    ? effectsOf(input.steps, intent, resource, [...entities.map((e) => nounPhrase(e)), nounPhrase(ctrlNoun)])
    : { effects: [], auditEntries: [], events: [] };
  let effects = [...stateChangesOf(input.steps, kind), ...fx.effects];
  let finalTarget = target;
  let finalResource = resource;
  // An intransitive creator ("register") creates whatever its chain creates.
  if (defaulted && kind === 'create' && !input.crud && !input.entity) {
    const created = effects.find((e) => e.verb === 'create');
    if (created) {
      finalResource = created.object.replace(/^the /, '');
      effects = effects.filter((e) => e !== created);
      finalTarget = parentText ? `a new ${finalResource} ${prep} ${parentText}` : `a new ${finalResource}`;
    }
  }

  const notFound = relevantNotFound(input.steps);
  const hasNotFound = notFound.length > 0;
  const subject = matchedIdx >= 0 ? resource : entities.length > 0 ? nounPhrase(entities[entities.length - 1]) : '';
  const existence = mutating && kind !== 'create' && hasNotFound && subject ? `the specified ${subject} must already exist` : undefined;

  const lifecycle: string[] = [];
  const softDeletes =
    input.entity?.softDelete || input.steps.some((s) => s.info.writes.some((w) => w.softDeletes));
  if (kind === 'delete' && softDeletes) {
    lifecycle.push(`the ${resource} is soft-deleted: it is marked as deleted rather than permanently removed`);
  }
  if ((kind === 'read') && hasNotFound && subject) {
    lifecycle.push(`if the specified ${subject} does not exist, the request fails`);
  }
  const relations: string[] = [];
  if (input.entity && entityFits(input, resource) && ['create', 'read', 'update'].includes(kind)) {
    const rel = input.entity.fields.filter((f) => f.relation);
    const belongs = rel.filter((f) => f.relation?.kind === 'ManyToOne' || f.relation?.kind === 'OneToOne').map((f) => nounPhrase(splitIdentifier(f.name)));
    const owns = rel.filter((f) => f.relation?.kind === 'OneToMany' || f.relation?.kind === 'ManyToMany').map((f) => nounPhrase(splitIdentifier(f.name)));
    if (belongs.length > 0) relations.push(`belongs to ${naturalList(belongs.slice(0, 3).map((b) => `${article(b)} ${b}`))}`);
    if (owns.length > 0) relations.push(`can have ${naturalList(owns.slice(0, 3))}`);
  }
  const has = (...names: string[]): boolean => input.queryParams.some((q) => names.includes(q));
  if (kind === 'list' && input.steps.some((s) => s.info.filtersDeleted) && !intent.deleted) {
    lifecycle.push(`soft-deleted ${pluralObject} are not included`);
  }
  const querying =
    kind === 'list' || kind === 'search'
      ? [has('filter') && 'filtered', has('search') && 'searched', has('sort') && 'sorted', has('page', 'limit') && 'paginated'].filter(
          (x): x is string => typeof x === 'string',
        )
      : [];

  const facts: Omit<EndpointBusinessFacts, 'claims'> = {
    action: { lead: verb.lead, kind, lemma: intent.lemma },
    resource: finalResource,
    target: finalTarget,
    request: requestFacts,
    ownerAssigned,
    initializations: kind === 'create' ? initializationsOf(input.steps) : [],
    effects,
    auditEntries: fx.auditEntries,
    events: fx.events,
    rules: ruleFacts.map((r) => r.rule),
    ruleFacts,
    existence,
    idempotent,
    lifecycle,
    relations,
    querying,
    result,
    response: {
      list: input.response.list,
      paginated: input.response.paginated,
      fields:
        input.response.fields.length === 1 && input.response.fields[0].label === resource
          ? []
          : fieldLabels(input.response.fields, resource).slice(0, MAX_LISTED_FIELDS),
      related: input.response.related,
    },
  };
  const claims = claimsOf(input, facts, {
    softDeletes: Boolean(softDeletes),
    filtersDeleted: kind === 'list' && input.steps.some((st) => st.info.filtersDeleted) && !intent.deleted,
    unique: takesInput ? unique : [],
  });
  const operation = operationOf(input);
  const conflicts = detectConflicts([...claims.flatMap((c) => positiveAssertion(c, operation) ?? []), ...stancesOf(input, operation)]);
  const gated = gateByConfidence({ ...facts, claims, conflicts }, operation);
  return { ...gated, depth: decideDepth({ claims: gated.claims, constraints: gated.request.constraints, withdrawn: gated.withdrawn, conflicts }) };
}

// ---- provenance ---------------------------------------------------------------

// Writes down which source evidence supports each behavioural claim. Rules
// aggregate every throw / guard in the chain: a rule is merged prose, so its
// evidence is the set of failures the chain can raise.
function claimsOf(
  input: EndpointSourceInput,
  f: Omit<EndpointBusinessFacts, 'claims'>,
  ctx: { softDeletes: boolean; filtersDeleted: boolean; unique: string[] },
): Fact[] {
  const steps = input.steps;
  const gather = (kind: string, match?: (d: Record<string, unknown>) => boolean): Evidence[] =>
    dedupeEvidence(steps.flatMap((st) => evidenceIn(st, kind, match)));
  const claims: Fact[] = [];
  // Where a piece of evidence sits relative to the operation: the nearest chain
  // step that recorded it; declarative evidence (entity) has no call path.
  const where = (e: Evidence): ObservationContext => {
    const holders = steps.filter((st) => st.info.evidence.some((x) => sameEvidence(x, e)));
    if (holders.length === 0) return { depth: 0, shared: false, conditioned: false, resolved: true };
    const nearest = holders.reduce((a, b) => (b.depth < a.depth ? b : a));
    return { depth: nearest.depth, shared: nearest.shared, conditioned: nearest.reachedWhen.length > 0, resolved: true };
  };
  const claim = (kind: string, evidence: Evidence[], subject?: string, confidence?: Confidence): void => {
    claims.push({ kind, ...(subject ? { subject } : {}), evidence, confidence: confidence ?? assess(observe(evidence, where)) });
  };
  const entityEvidence = (match: (d: Record<string, unknown>) => boolean): Evidence[] =>
    dedupeEvidence((input.entity?.evidence ?? []).filter((e) => match(e.details ?? {})));

  if (handlerOf(input).usesAuthUser) claim('actor', gather(EVIDENCE.actorUse));
  if (f.ownerAssigned) claim('ownership', gather(EVIDENCE.actorBoundProperty, (d) => OWNERSHIP.test(String(d.prop))));
  for (const init of f.initializations) claim('initialization', dedupeEvidence([...gather(EVIDENCE.plainCall), ...gather(EVIDENCE.serviceCall), ...gather(EVIDENCE.sameClassCall)].filter((e) => INITIALIZER.test(lastSegment(String(e.details?.call ?? ''))))), init);
  for (const e of f.effects) claim(e.verb === 'set' ? 'state-change' : 'side-effect', dedupeEvidence(e.evidence ?? []), `${e.verb} ${e.object}`);
  for (const a of f.auditEntries) claim('audit-entry', gather(EVIDENCE.auditRecord, (d) => hyphenLabel(String(d.action)) === a), a);
  for (const ev of f.events) claim('event', gather(EVIDENCE.eventEmit, (d) => hyphenLabel(String(d.event)) === ev), ev);
  for (const r of f.rules) {
    const rf = f.ruleFacts.find((x) => x.rule === r);
    claim('rule', dedupeEvidence(rf?.failures.flatMap((fl) => fl.evidence) ?? []), r, rf?.confidence);
  }
  if (f.existence) {
    // Only a not-found failure the chain shows to be relevant supports the existence claim.
    const absent = relevantNotFound(steps);
    claim('existence', dedupeEvidence(absent.flatMap((fl) => fl.evidence)), f.existence, bestOf(absent.map((fl) => fl.confidence)));
  }
  if (f.request.partial) claim('partial-update', gather(EVIDENCE.mergeInput));
  if (f.idempotent) claim('idempotence', gather(EVIDENCE.idempotenceMarker));
  if (ctx.softDeletes) claim('soft-deletion', dedupeEvidence([...entityEvidence((d) => d.marks === 'soft-delete'), ...gather(EVIDENCE.persistenceWrite)]));
  if (ctx.filtersDeleted) claim('soft-delete-filter', gather(EVIDENCE.softDeleteFilter));
  if (f.relations.length > 0) claim('relation', entityEvidence((d) => 'kind' in d));
  if (f.request.defaults.length > 0) claim('default', entityEvidence((d) => 'default' in d));
  if (ctx.unique.length > 0) claim('unique-constraint', entityEvidence((d) => d.unique === true));
  return claims;
}

// Claims whose confidence is below this are not stated as facts.
const GATED_KINDS = new Set(['rule', 'existence', 'partial-update', 'side-effect', 'state-change', 'event', 'audit-entry']);

// The comparable fact each behavioural claim states. Adapters that record a
// stance about the same fact use the same (dimension, subject): 'affirm' backs
// the claim, 'negate' opposes it.
export const STANCE_AFFIRM = 'affirm';
export const STANCE_NEGATE = 'negate';
const CLAIM_FACTS: Record<string, (subject?: string) => { dimension: string; subject: string }> = {
  ownership: () => ({ dimension: 'ownership', subject: 'owner' }),
  existence: () => ({ dimension: 'existence', subject: 'target' }),
  'partial-update': () => ({ dimension: 'partial-update', subject: 'input' }),
  rule: (s) => ({ dimension: 'rule', subject: s ?? '' }),
  'side-effect': (s) => ({ dimension: 'effect', subject: s ?? '' }),
  'state-change': (s) => ({ dimension: 'effect', subject: s ?? '' }),
  event: (s) => ({ dimension: 'event', subject: s ?? '' }),
  'audit-entry': (s) => ({ dimension: 'audit', subject: s ?? '' }),
};
export const claimFact = (kind: string, subject?: string): { dimension: string; subject: string } | undefined => CLAIM_FACTS[kind]?.(subject);
const operationOf = (input: EndpointSourceInput): string => `${input.controllerClassName}.${input.methodName}`;

// A claim as an assertion: what the engine's own analysis affirms.
function positiveAssertion(c: Fact, operation: string): Assertion | undefined {
  const fact = claimFact(c.kind, c.subject);
  if (!fact || !c.confidence) return undefined;
  return { ...fact, operation, cardinality: 'single', value: STANCE_AFFIRM, confidence: c.confidence, source: { origin: 'derived-claim', discoverer: c.kind, path: [], evidence: c.evidence } };
}

// Stances adapters recorded while reading the chain, placed where their step sits.
function stancesOf(input: EndpointSourceInput, operation: string): Assertion[] {
  return input.steps.flatMap((st) =>
    st.info.assertions.map(({ seed, evidence }) => ({
      ...seed,
      operation,
      confidence: assess(observe([evidence], () => ({ depth: st.depth, shared: st.shared, conditioned: st.reachedWhen.length > 0, resolved: true }))),
      source: { origin: 'adapter', discoverer: evidence.kind, path: st.path, evidence: [evidence] },
    })),
  );
}

// The semantic gate: a behavioural claim the source proves only weakly (or
// whose evidence cannot be tied to this operation), or that other evidence
// contradicts unresolved (or resolves against it), is withdrawn together with
// the fact it supports, rather than stated.
function gateByConfidence(f: EndpointBusinessFacts, operation: string): EndpointBusinessFacts {
  const conflicts = f.conflicts ?? [];
  const weakClaim = (c: Fact): boolean => GATED_KINDS.has(c.kind) && c.confidence !== undefined && !meets(c.confidence, 'medium');
  const disputed = (c: Fact): boolean => {
    const fact = claimFact(c.kind, c.subject);
    return fact !== undefined && withdrawsClaim(conflicts, { ...fact, operation }, STANCE_AFFIRM);
  };
  const dropped = (c: Fact): boolean => weakClaim(c) || disputed(c);
  const weak = (kind: string, subject?: string): boolean => f.claims.some((c) => c.kind === kind && (subject === undefined || c.subject === subject) && dropped(c));
  const stateKind = (verb: string): string => (verb === 'set' ? 'state-change' : 'side-effect');
  if (!f.claims.some(dropped)) return f;
  const rules = f.rules.filter((r) => !weak('rule', r));
  return {
    ...f,
    rules,
    ruleFacts: f.ruleFacts.filter((rf) => rules.includes(rf.rule)),
    ownerAssigned: f.ownerAssigned && !weak('ownership'),
    existence: f.existence !== undefined && weak('existence') ? undefined : f.existence,
    request: weak('partial-update') ? { ...f.request, partial: false } : f.request,
    effects: f.effects.filter((e) => !weak(stateKind(e.verb), `${e.verb} ${e.object}`)),
    events: f.events.filter((ev) => !weak('event', ev)),
    auditEntries: f.auditEntries.filter((a) => !weak('audit-entry', a)),
    claims: f.claims.filter((c) => !dropped(c)),
    withdrawn: f.claims.filter(dropped).map((c) => ({ kind: c.kind, ...(c.subject ? { subject: c.subject } : {}), reason: disputed(c) ? ('disputed' as const) : ('low-confidence' as const) })),
  };
}

// Claims the engine made without any source evidence behind them.
export const unsupportedClaims = (f: EndpointBusinessFacts): Fact[] => f.claims.filter((c) => c.evidence.length === 0);

export { fieldLabel, plural, nominal };
