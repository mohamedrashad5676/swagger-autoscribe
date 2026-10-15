#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildDocument } from './setup';
import { computeCoverage, diffDocuments, type CoverageReport } from './check';
import { FEATURES, resolveOptionsDetailed } from './options';
import type { AutoDocOptions, Feature } from './types';

const HELP = `swagger-autodoc config [--json]     show which features are on (config file + SWAGGER_AUTODOC_* env)

swagger-autodoc check --app <file> [options]

  --app <file>              compiled JS file of your app. It must export either
                            \`createApp(): Promise<INestApplication>\` (preferred: configure prefix, pipes,
                            versioning, then return the app WITHOUT listen()) or your root module class
                            (pick it with --export, default: AppModule). It may also export \`autodocOptions\`.
  --baseline <file>         OpenAPI JSON to compare against (breaking changes fail the check)
  --update-baseline         write the current document to --baseline and exit 0
  --allow-breaking          report breaking changes but do not fail
  --min-response-schemas N  fail below N% of endpoints with a typed 2xx response   (default: no gate)
  --min-descriptions N      fail below N% of endpoints with a description
  --min-request-bodies N    fail below N% of POST/PUT/PATCH with a documented body
  --min-errors N            fail below N% of endpoints with at least one 4xx response
  --prefix <p>              (module mode) global prefix, like app.setGlobalPrefix(p)
  --versioning-uri          (module mode) enable URI versioning
  --validation              (module mode) add a global ValidationPipe
  --out <file>              also write the current OpenAPI document
  --preset <standard|minimal>  start from a feature bundle
  --disable a,b             switch features off (auth, rbac, pagination, dtos, requestBodies, responses, examples,
  --enable a,b                errors, descriptions, summaries, queryParams, uploads, rateLimit, asyncEndpoints)
  --json                    machine readable output
`;

interface Args {
  [k: string]: string | boolean | undefined;
}

function parse(argv: string[]): { cmd?: string; args: Args } {
  const [cmd, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else args[key] = true;
  }
  return { cmd, args };
}

// `import()` that survives CommonJS compilation, so ESM-only apps (Nest 12) load too.
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function loadFromProject(spec: string, cwd: string): Promise<any> {
  const req = createRequire(path.join(cwd, 'package.json'));
  return dynamicImport(pathToFileURL(req.resolve(spec)).href);
}

async function createApplication(file: string, exportName: string, cwd: string, args: Args): Promise<{ app: any; options: AutoDocOptions }> {
  await loadFromProject('reflect-metadata', cwd).catch(() => undefined);
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) throw new Error(`${file} not found. Build your app first and pass the compiled .js file.`);
  const mod = await dynamicImport(pathToFileURL(full).href);
  const ns = mod.default && typeof mod.default === 'object' ? { ...mod.default, ...mod } : mod;
  const options: AutoDocOptions = ns.autodocOptions ?? {};
  const factory = ns.createApp ?? (typeof mod.default === 'function' && !/^class\s/.test(String(mod.default)) ? mod.default : undefined);
  if (factory) return { app: await factory(), options };
  const root = ns[exportName] ?? (typeof mod.default === 'function' ? mod.default : undefined);
  if (!root) throw new Error(`${file} exports neither createApp() nor ${exportName}. Use --export <ModuleName>.`);
  const { NestFactory } = await loadFromProject('@nestjs/core', cwd);
  const app = await NestFactory.create(root, { logger: false });
  const common = await loadFromProject('@nestjs/common', cwd);
  if (typeof args.prefix === 'string') app.setGlobalPrefix(args.prefix);
  if (args['versioning-uri']) app.enableVersioning({ type: common.VersioningType.URI });
  if (args.validation) app.useGlobalPipes(new common.ValidationPipe({ whitelist: true }));
  return { app, options };
}

const pct = (r: { percent: number; covered: number; total: number }): string => `${r.percent.toFixed(1)}% (${r.covered}/${r.total})`;

function gate(report: CoverageReport, args: Args): string[] {
  const rules: Array<[string, keyof CoverageReport]> = [
    ['min-response-schemas', 'responseSchemas'],
    ['min-descriptions', 'descriptions'],
    ['min-request-bodies', 'requestBodies'],
    ['min-errors', 'errorResponses'],
  ];
  const failures: string[] = [];
  for (const [flag, key] of rules) {
    if (args[flag] === undefined) continue;
    const min = Number(args[flag]);
    const r = report[key] as { percent: number };
    if (Number.isNaN(min)) throw new Error(`--${flag} needs a number`);
    if (r.percent < min) failures.push(`${key} ${r.percent}% is below the required ${min}%`);
  }
  return failures;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const { cmd, args } = parse(argv);
  if (cmd === 'config' && !args.help) {
    try {
      const info = resolveOptionsDetailed({ sources: { cwd } });
      if (args.json) {
        process.stdout.write(JSON.stringify({ preset: info.preset, configFile: info.configFile ?? null, features: info.features, warnings: info.warnings }, null, 2) + '\n');
      } else {
        const lines = [`Preset:      ${info.preset}`, `Config file: ${info.configFile ?? '(none)'}`, '', ...FEATURES.map((f) => `${info.features[f] ? 'on ' : 'off'}  ${f}`)];
        if (info.warnings.length) lines.push('', ...info.warnings.map((w) => `warning: ${w}`));
        process.stdout.write(lines.join('\n') + '\n');
      }
      return 0;
    } catch (e) {
      process.stderr.write(`swagger-autodoc: ${(e as Error).message}\n`);
      return 2;
    }
  }
  if (!cmd || cmd === 'help' || args.help || cmd !== 'check') {
    process.stdout.write(HELP);
    return cmd === 'check' || !cmd || cmd === 'help' ? 0 : 2;
  }
  if (typeof args.app !== 'string') {
    process.stderr.write('Missing --app <file>\n\n' + HELP);
    return 2;
  }
  let app: any;
  try {
    const created = await createApplication(args.app, typeof args.export === 'string' ? args.export : 'AppModule', cwd, args);
    app = created.app;
    const cli: AutoDocOptions = {};
    const list = (v: string | boolean | undefined): Feature[] => (typeof v === 'string' ? (v.split(',').map((x) => x.trim()).filter(Boolean) as Feature[]) : []);
    if (typeof args.preset === 'string') cli.preset = args.preset as 'standard' | 'minimal';
    if (args.disable) cli.disable = list(args.disable);
    if (args.enable) cli.enable = list(args.enable);
    const doc = buildDocument(app, { logger: false, ...created.options, ...cli, sources: { cwd, ...created.options.sources } });
    const report = computeCoverage(doc);
    const failures = gate(report, args);
    let changes: ReturnType<typeof diffDocuments> = [];
    let baselineNote = '';
    const baselinePath = typeof args.baseline === 'string' ? path.resolve(cwd, args.baseline) : undefined;
    if (args['update-baseline']) {
      if (!baselinePath) throw new Error('--update-baseline needs --baseline <file>');
      fs.writeFileSync(baselinePath, JSON.stringify(doc, null, 2));
      baselineNote = `baseline written to ${args.baseline}`;
    } else if (baselinePath) {
      if (fs.existsSync(baselinePath)) changes = diffDocuments(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), doc);
      else baselineNote = `baseline ${args.baseline} not found - run with --update-baseline to create it`;
    }
    if (typeof args.out === 'string') fs.writeFileSync(path.resolve(cwd, args.out), JSON.stringify(doc, null, 2));
    const breaking = changes.filter((c) => c.kind === 'breaking');
    const failed = failures.length > 0 || (breaking.length > 0 && !args['allow-breaking']);
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: !failed, coverage: report, gateFailures: failures, changes, baseline: baselineNote || undefined }, null, 2) + '\n');
    } else {
      const lines = [
        `Endpoints:            ${report.endpoints}`,
        `Typed 2xx responses:  ${pct(report.responseSchemas)}`,
        `Descriptions:         ${pct(report.descriptions)}`,
        `Request bodies:       ${pct(report.requestBodies)}`,
        `Documented 4xx:       ${pct(report.errorResponses)}`,
      ];
      if (report.untypedResponses.length) lines.push('', 'No typed 2xx response:', ...report.untypedResponses.slice(0, 20).map((k) => `  - ${k}`));
      if (baselineNote) lines.push('', baselineNote);
      if (changes.length) {
        lines.push('', `Changes vs baseline: ${breaking.length} breaking, ${changes.length - breaking.length} other`);
        for (const c of changes) lines.push(`  ${c.kind === 'breaking' ? 'BREAKING' : 'info    '} ${c.endpoint}: ${c.message}`);
      }
      if (failures.length) lines.push('', ...failures.map((f) => `FAIL ${f}`));
      lines.push('', failed ? 'check FAILED' : 'check passed');
      process.stdout.write(lines.join('\n') + '\n');
    }
    return failed ? 1 : 0;
  } catch (e) {
    process.stderr.write(`swagger-autodoc: ${(e as Error).message}\n`);
    return 2;
  } finally {
    try {
      await app?.close();
    } catch {
      /* ignore */
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
