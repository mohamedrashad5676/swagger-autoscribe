export { setupSwagger, buildDocument, writeOpenApiFile } from './setup';
export { SwaggerEnhancer, enhanceDocument } from './enhancer/enhancer';
export { getSwaggerConfig, type SwaggerConfig } from './config';
export type {
  AutoDocOptions,
  AuthOptions,
  RbacOptions,
  PaginationOptions,
  ResourceOptions,
  ResponseEnvelope,
  ResponseOptions,
  ErrorOptions,
  DtoOptions,
  SourceOptions,
  HandlerContext,
  MetadataKey,
  EnhancerMode,
  Feature,
  OperationFeature,
  OperationContext,
  OperationRule,
  HooksOptions,
  ExamplesConfig,
} from './types';
export { resolveOptions, resolveOptionsDetailed, FEATURES } from './options';

// building blocks, usable on their own
export { SourceSchemaExtractor, buildCompilerOptions, type JsonSchema, type ExtractorOptions } from './schema/source-schema-extractor';
export { createExampleGenerator, generateExample, type ExampleOptions } from './schema/example-generator';
export { match, eq, endsWith, startsWith, contains, anyOf, type ExampleMatcher, type NameInfo } from './schema/example-matchers';
export { SourceIndex, detectSourceRoots } from './source/source-index';
export { RuntimeErrorScanner, type RuntimeErrorVariant, type RuntimeErrorScannerOptions } from './errors/scanner';
export { CrossServiceScanner, type CrossServiceOptions } from './errors/cross-service';
export { deriveValidationMessages } from './errors/validation-messages';
export { describeVariants, type DescribeOptions } from './errors/error-description';
export { onmeetingPreset, ONMEETING_EXAMPLE_MATCHERS, type OnMeetingPresetInput } from './presets/onmeeting';
export * from './check';
export type { EnvironmentsOptions, EnvironmentCapture } from './ui/environments';
export { defaultCaptures } from './ui/environments';
