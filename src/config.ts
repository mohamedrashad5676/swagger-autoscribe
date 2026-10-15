export interface SwaggerConfig {
  enabled: boolean;
  path: string;
  title: string;
  description: string;
  version: string;
}

/**
 * Reads the usual environment switches. Every value can be overridden by the
 * explicit options passed to `setupSwagger()`.
 *
 *   SWAGGER_DISABLED=true   turn the docs off (recommended in production)
 *   SWAGGER_PATH            UI path (default `docs`)
 *   SWAGGER_TITLE / SWAGGER_DESCRIPTION / SWAGGER_VERSION
 */
export function getSwaggerConfig(defaults: Partial<SwaggerConfig> = {}): SwaggerConfig {
  return {
    enabled: defaults.enabled ?? process.env.SWAGGER_DISABLED !== 'true',
    path: process.env.SWAGGER_PATH || defaults.path || 'docs',
    title: process.env.SWAGGER_TITLE || defaults.title || 'API',
    description: process.env.SWAGGER_DESCRIPTION || defaults.description || 'REST API documentation',
    version: process.env.SWAGGER_VERSION || defaults.version || '1.0',
  };
}
