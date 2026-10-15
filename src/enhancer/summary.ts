/**
 * Deterministic one-line `summary` for operations that have none.
 * Pure function of (controller, method, HTTP verb, route shape) — no guessing
 * from code bodies, so the same app always yields the same text.
 */
export interface SummaryInput {
  controllerName: string;
  methodName: string;
  httpMethod: string;
  path: string;
  /** Resource class name from a `resource` convention, preferred over the controller name. */
  resourceName?: string;
}

const humanize = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

export function singularize(word: string): string {
  const w = word;
  if (/(ies)$/i.test(w) && w.length > 4) return w.replace(/ies$/i, 'y');
  if (/(sses|xes|ches|shes)$/i.test(w)) return w.replace(/es$/i, '');
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/s$/i.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

export function pluralize(word: string): string {
  if (/(ss|us|is|x|ch|sh)$/i.test(word)) return `${word}es`;
  if (/s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  return `${word}s`;
}

function resourceWords(input: SummaryInput): string {
  const base = (input.resourceName || input.controllerName).replace(/Controller$/, '').replace(/(Dto|Resource|Response)$/, '');
  const words = humanize(base).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join(' ');
}

const CREATE = /^(create|add|register|insert|new|store|post)$/;
const LIST = /^(find\s?all|get\s?all|list|find\s?many|index|search|all|get\s?list|fetch\s?all|paginate)$/;
const ONE = /^(one|find\s?one|get\s?one|get|find|show|read|get\s?by\s?id|find\s?by\s?id|fetch|details?|view|retrieve)$/;
const UPDATE = /^(update|patch|edit|modify|replace|put|save)$/;
const REMOVE = /^(remove|delete|destroy|erase)$/;

export function generateSummary(input: SummaryInput): string | undefined {
  const resource = resourceWords(input);
  const verb = input.httpMethod.toLowerCase();
  const endsWithParam = /\/(:[^/]+|\{[^}]+\})$/.test(input.path);
  const method = humanize(input.methodName);
  const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const words = method.split(' ');
  // `findAllUsers` / `createUser`: the method already names the resource.
  const lead = words[0];
  const rest = words.slice(1).join(' ');
  const restIsResource = rest.length > 0 && resource.length > 0 && singularize(rest.split(' ').pop() as string) === resource.split(' ').pop();
  const target = (plural: boolean): string => (resource ? (plural ? pluralize(resource) : resource) : rest || 'item');

  const whole = method.replace(/\s/g, '');
  const classify = (m: string): 'create' | 'list' | 'one' | 'update' | 'remove' | undefined => {
    if (CREATE.test(m)) return 'create';
    if (LIST.test(m)) return 'list';
    if (ONE.test(m)) return 'one';
    if (UPDATE.test(m)) return 'update';
    if (REMOVE.test(m)) return 'remove';
    return undefined;
  };
  let kind = classify(method) ?? classify(whole);
  if (!kind && restIsResource) {
    kind = classify(lead);
    const plural = singularize(rest.split(' ').pop() as string) !== rest.split(' ').pop();
    if (kind === 'one' && (rest.startsWith('all ') || (plural && !endsWithParam))) kind = 'list';
  }

  if (kind === 'create') return `Create ${target(false)}`;
  if (kind === 'list') return `List ${target(true)}`;
  if (kind === 'one') return `Get ${target(false)}`;
  if (kind === 'update') return `Update ${target(false)}`;
  if (kind === 'remove') return `Delete ${target(false)}`;
  if (!method) return undefined;
  if (restIsResource) {
    const plural = singularize(rest) !== rest;
    return cap(`${lead} ${plural ? pluralize(resource) : resource}`);
  }
  return cap(method);
}
