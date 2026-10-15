import * as fs from 'node:fs';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject, type SwaggerCustomOptions } from '@nestjs/swagger';
import { cacheDir, computeCacheKey, readCached, writeCached } from './cache';
import { getSwaggerConfig } from './config';
import { SwaggerEnhancer } from './enhancer/enhancer';
import { createLogger } from './logger';
import { resolveOptions } from './options';
import type { AutoDocOptions } from './types';
import { environmentsScript, resolveEnvironments } from './ui/environments';

/**
 * Builds the OpenAPI document (via @nestjs/swagger) and enhances it — without
 * mounting any UI. Use it to export the spec at build time or in tests.
 */
export function buildDocument(app: INestApplication, input: AutoDocOptions = {}): OpenAPIObject {
  const options = resolveOptions(input);
  const cfg = getSwaggerConfig({
    path: options.path,
    title: options.title,
    description: options.description,
    version: options.version,
  });
  let builder = new DocumentBuilder().setTitle(cfg.title).setDescription(cfg.description).setVersion(cfg.version);
  if (options.builder) builder = options.builder(builder);
  const document = SwaggerModule.createDocument(app, builder.build(), options.documentOptions);
  const cwd = options.sources?.cwd ?? process.cwd();
  const dir = cacheDir(options.cache, cwd);
  let key: string | undefined;
  if (dir) {
    try {
      key = computeCacheKey(app, options, document, cwd);
      const hit = readCached(dir, key);
      if (hit) {
        createLogger('SwaggerAutoDoc', options.logger).log(`Using cached document (${key.slice(0, 8)})`);
        return sanitizeDocument(hit);
      }
    } catch {
      key = undefined;
    }
  }
  const result = new SwaggerEnhancer(app, options).process(document);
  if (dir && key) writeCached(dir, key, result);
  return sanitizeDocument(result);
}

/**
 * One call: create the document, enhance it, serve the UI.
 *
 * Call it after your global prefix / versioning / global guards, filters and
 * pipes are registered and right before `app.listen()` — the enhancer reads
 * the live application (it documents what is really applied).
 *
 * Returns the document, or `undefined` when docs are disabled.
 */
export function setupSwagger(app: INestApplication, input: AutoDocOptions = {}): OpenAPIObject | undefined {
  const options = resolveOptions(input);
  const cfg = getSwaggerConfig({
    enabled: options.enabled,
    path: options.path,
    title: options.title,
    description: options.description,
    version: options.version,
  });
  const logger = createLogger('SwaggerAutoDoc', options.logger);
  if (!cfg.enabled) {
    logger.log('Swagger is disabled');
    return undefined;
  }
  try {
    const document = buildDocument(app, options);
    SwaggerModule.setup(cfg.path, app, document, withEnvironments(options, document));
    logger.log(`Swagger UI available at /${cfg.path.replace(/^\/+/, '')}`);
    return document;
  } catch (e) {
    // Documentation must never be the reason an API fails to boot.
    logger.warn(`Swagger setup failed, continuing without docs: ${(e as Error).stack ?? (e as Error).message}`);
    return undefined;
  }
}

/** Writes the enhanced document to disk (CI artifacts, client generation, contract tests). */
export function writeOpenApiFile(document: OpenAPIObject, filePath: string): string {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(document, null, 2));
  return target;
}

/**
 * @nestjs/swagger injects the document JSON into swagger-ui-init.js with
 * String.prototype.replace and a *string* replacement, so the sequences
 * `$\``, `$'`, `$&`, `$$` inside any description would be expanded by
 * JS and corrupt the script. Neutralise them in human text (rendered as
 * Markdown/HTML, where `&#36;` displays as `$`).
 */
export function sanitizeDocument<T>(doc: T): T {
  const human = (t: string) => t.replace(/\$(?=[`'&$])/g, '&#36;');
  // Data strings (examples, messages, enums): keep text, break the sequence invisibly.
  const data = (t: string) => t.replace(/\$(?=[`'&$])/g, '$\u200b');
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') o[k] = k === 'description' || k === 'summary' ? human(v) : data(v);
      else walk(v);
    }
  };
  walk(doc);
  return doc;
}

function withEnvironments(options: AutoDocOptions, document: OpenAPIObject): SwaggerCustomOptions | undefined {
  const config = resolveEnvironments(options.environments, document);
  if (!config) return options.uiOptions;
  const ui = options.uiOptions ?? {};
  const existing = ui.customJsStr === undefined ? [] : Array.isArray(ui.customJsStr) ? ui.customJsStr : [ui.customJsStr];
  const swaggerOptions = { ...(ui.swaggerOptions ?? {}) } as Record<string, any>;
  swaggerOptions.requestInterceptor = requestInterceptorFor(swaggerOptions.requestInterceptor);
  return { ...ui, swaggerOptions, customJsStr: [...existing, environmentsScript(config)] };
}

/** Swagger UI's `requestInterceptor` (serialised into the page): resolves the variables first, then runs the project's own hook. */
export function requestInterceptorFor(user?: (req: any) => any): (req: any) => any {
  const own = user ? `var u = (${user.toString()}); ` : '';
  const call = user ? 'var o = u.call(this, r); return o === undefined ? r : o;' : 'return r;';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('req', `${own}var e = window.__autodocEnv; var r = e && e.interceptRequest ? e.interceptRequest(req) : req; ${call}`) as (req: any) => any;
}
