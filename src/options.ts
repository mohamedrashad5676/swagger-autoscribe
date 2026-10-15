import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger';
import type { AutoDocOptions, Feature, OperationContext, OperationFeature, OperationRule } from './types';

export const FEATURES: readonly Feature[] = [
  'auth', 'rbac', 'pagination', 'dtos', 'requestBodies', 'responses', 'examples', 'errors',
  'descriptions', 'summaries', 'queryParams', 'uploads', 'rateLimit', 'asyncEndpoints', 'behavior', 'listing',
];

/** Features the `minimal` preset leaves on — none of them reads your source code. */
const MINIMAL_ON: readonly Feature[] = ['auth', 'rbac', 'pagination', 'rateLimit', 'behavior', 'listing'];

const CONFIG_FILES = ['swagger-autodoc.config.js', 'swagger-autodoc.config.cjs', 'swagger-autodoc.config.json', '.swagger-autodocrc.json'];

const resolvedMarker = new WeakSet<object>();

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Plain objects merge recursively; everything else (arrays, functions, regexes, class instances) is replaced. `over` wins. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const csv = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export interface ResolvedInfo {
  options: AutoDocOptions;
  /** Effective on/off state of every feature. */
  features: Record<Feature, boolean>;
  configFile?: string;
  preset: 'standard' | 'minimal';
  warnings: string[];
}

function loadConfigFile(options: AutoDocOptions, cwd: string, warn: (m: string) => void): { file?: string; data?: Record<string, unknown> } {
  if (options.configFile === false) return {};
  const explicit = options.configFile ?? process.env.SWAGGER_AUTODOC_CONFIG;
  const candidates = explicit ? [path.resolve(cwd, explicit)] : CONFIG_FILES.map((f) => path.join(cwd, f));
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      if (explicit) throw new Error(`swagger-autodoc: config file not found: ${file}`);
      continue;
    }
    try {
      let data: unknown;
      if (file.endsWith('.json')) data = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(file) as { default?: unknown };
        data = mod && typeof mod === 'object' && 'default' in mod && isPlain(mod.default) ? mod.default : mod;
      }
      if (isPlain(data)) return { file, data };
      warn(`Config file ${file} must export an object — ignored`);
    } catch (e) {
      if (explicit) throw new Error(`swagger-autodoc: cannot read config file ${file}: ${(e as Error).message}`);
      warn(`Config file ${file} could not be loaded (${(e as Error).message}) — ignored`);
    }
    return {};
  }
  if (!explicit) {
    const pkg = path.join(cwd, 'package.json');
    try {
      if (fs.existsSync(pkg)) {
        const data = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as Record<string, unknown>).swaggerAutodoc;
        if (isPlain(data)) return { file: `${pkg}#swaggerAutodoc`, data };
      }
    } catch {
      /* unreadable package.json: no config */
    }
  }
  return {};
}

const turnOff = (o: Record<string, unknown>, f: Feature): void => {
  o[f] = false;
};

const turnOn = (o: Record<string, unknown>, f: Feature): void => {
  const v = o[f];
  if (v === false) {
    if (f === 'rbac') o[f] = {};
    else delete o[f];
  } else if (isPlain(v) && v.enabled === false) {
    const { enabled: _enabled, ...rest } = v;
    void _enabled;
    o[f] = rest;
  } else if (f === 'rbac' && (v === undefined || v === true)) o[f] = {};
};

/**
 * Turns user input (options + config file + preset + env) into the one options object the package works with.
 * Precedence, lowest to highest: preset < config file < explicit options < `enable` < `disable` < env.
 */
export function resolveOptionsDetailed(input: AutoDocOptions = {}): ResolvedInfo {
  const warnings: string[] = [];
  const cwd = input.sources?.cwd ?? process.cwd();
  const file = loadConfigFile(input, cwd, (m) => warnings.push(m));
  const merged = (file.data ? deepMerge(file.data, input) : { ...input }) as Record<string, unknown>;

  const preset = (process.env.SWAGGER_AUTODOC_PRESET ?? merged.preset ?? 'standard') as 'standard' | 'minimal';
  if (preset === 'minimal') {
    for (const f of FEATURES) if (!MINIMAL_ON.includes(f) && merged[f] === undefined) turnOff(merged, f);
  } else if (preset !== 'standard') warnings.push(`Unknown preset "${String(preset)}" — using "standard"`);

  const known = new Set<string>(FEATURES);
  const list = (v: unknown, where: string): Feature[] => {
    const names = Array.isArray(v) ? (v as string[]) : [];
    const out: Feature[] = [];
    for (const n of names) {
      if (known.has(n)) out.push(n as Feature);
      else warnings.push(`Unknown feature "${n}" in ${where} (known: ${FEATURES.join(', ')})`);
    }
    return out;
  };
  for (const f of list(merged.enable, 'enable')) turnOn(merged, f);
  for (const f of list(merged.disable, 'disable')) turnOff(merged, f);
  for (const f of list(csv(process.env.SWAGGER_AUTODOC_ENABLE), 'SWAGGER_AUTODOC_ENABLE')) turnOn(merged, f);
  for (const f of list(csv(process.env.SWAGGER_AUTODOC_DISABLE), 'SWAGGER_AUTODOC_DISABLE')) turnOff(merged, f);

  for (const f of FEATURES) {
    const v = merged[f];
    if (isPlain(v) && v.enabled === false) merged[f] = false;
    else if (v === true && f !== 'rbac') delete merged[f];
    else if (v === true) merged[f] = {};
  }
  merged.preset = preset === 'minimal' ? 'minimal' : 'standard';
  delete merged.enable;
  delete merged.disable;
  const options = merged as AutoDocOptions;
  resolvedMarker.add(options);

  const features = {} as Record<Feature, boolean>;
  for (const f of FEATURES) features[f] = f === 'rbac' ? Boolean(merged[f]) : merged[f] !== false;
  return { options, features, configFile: file.file, preset: merged.preset as 'standard' | 'minimal', warnings };
}

/** Idempotent: an already-resolved object is returned as is. */
export function resolveOptions(input: AutoDocOptions = {}): AutoDocOptions {
  if (resolvedMarker.has(input)) return input;
  const { options, warnings } = resolveOptionsDetailed(input);
  if (warnings.length) {
    const log = createLogger('SwaggerAutoDoc', options.logger);
    for (const w of warnings) log.warn(w);
  }
  return options;
}

// -------------------------------------------------------- per-operation rules

const VERBS = /^(get|post|put|patch|delete|head|options|all)$/i;
const norm = (p: string): string => p.replace(/\{([^}/]+)\}/g, ':$1');

function targetsOf(ctx: OperationContext): string[] {
  const verb = ctx.method.toUpperCase();
  const p = norm(ctx.path);
  const out = [`${verb}:${p}`, `${verb} ${p}`];
  if (ctx.controllerName && ctx.methodName) {
    out.push(`${ctx.controllerName}.${ctx.methodName}`, `${ctx.controllerName}.${verb}:${p}`);
  }
  return out;
}

function matches(match: string | RegExp, ctx: OperationContext): boolean {
  const targets = targetsOf(ctx);
  if (match instanceof RegExp) {
    return targets.some((t) => {
      match.lastIndex = 0;
      return match.test(t);
    });
  }
  let pattern = norm(match.trim());
  const verbEnd = pattern.search(/[: ]/);
  if (verbEnd > 0 && VERBS.test(pattern.slice(0, verbEnd))) pattern = pattern.slice(0, verbEnd).toUpperCase() + pattern.slice(verbEnd);
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return targets.some((t) => re.test(t));
  }
  return targets.includes(pattern);
}

/** Features switched off for one operation. Rules apply in order (a later `enable` can undo an earlier `disable`); a function runs last. */
export function disabledFor(rules: AutoDocOptions['operations'], ctx: OperationContext): Set<OperationFeature> {
  const off = new Set<OperationFeature>();
  if (!rules) return off;
  const apply = (r: { disable?: OperationFeature[]; enable?: OperationFeature[] } | void): void => {
    if (!r) return;
    for (const f of r.disable ?? []) off.add(f);
    for (const f of r.enable ?? []) off.delete(f);
  };
  if (typeof rules === 'function') apply(rules(ctx));
  else for (const rule of rules as OperationRule[]) if (matches(rule.match, ctx)) apply(rule);
  return off;
}
