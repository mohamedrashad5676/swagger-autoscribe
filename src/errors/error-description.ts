import type { JsonSchema } from '../schema/source-schema-extractor';

// Builds the always-visible bullet list of every distinct error variant
// for one response's `description`. Swagger UI only ever shows ONE
// selected example at a time (and some versions render just the first) —
// the description is the only thing guaranteed to display ALL variants
// with zero interaction, in every renderer (Swagger UI, Redoc, RapiDoc).
// Markdown bullets; OpenAPI descriptions are CommonMark.
export interface DescribedVariant {
  message?: string;
  messages?: string[];
  condition?: string;
  schema?: JsonSchema;
  isValidationPipe?: boolean;
}

const DEFAULT_MAX_BULLETS = 10;

export const DEFAULT_HIDDEN_CONDITION_PATTERNS: RegExp[] = [
  /^!authHeader$/,
  /^scheme !== ['"]Bearer['"]( \|\| !token)?$/,
  /^!validatedToken( \|\| !validatedToken\.\w+)?$/,
  /^!validatedToken\.\w+$/,
  /^catch \(error\)$/,
];

export interface DescribeOptions {
  /** Bare guard throws whose `if` condition matches any of these are not listed (pure noise: `!authHeader`, ...). */
  hiddenConditions?: RegExp[];
  maxBullets?: number;
}

export function describeVariants(variants: DescribedVariant[], options: DescribeOptions = {}): string[] {
  const hidden = options.hiddenConditions ?? DEFAULT_HIDDEN_CONDITION_PATTERNS;
  const isHidden = (cond: string): boolean => hidden.some((p) => p.test(cond));
  const MAX_BULLETS = options.maxBullets ?? DEFAULT_MAX_BULLETS;
  const lines: string[] = [];
  for (const v of variants) {
    if (v.isValidationPipe) {
      const samples = (v.messages ?? []).slice(0, 3).map((m) => `"${m}"`);
      const extra = (v.messages ?? []).length > 3 ? ` (+${(v.messages ?? []).length - 3} more)` : '';
      lines.push(`Validation failed, e.g. ${samples.join('; ')}${extra}`);
      continue;
    }
    if (typeof v.message === 'string' && v.message.length > 0) {
      lines.push(`\`${v.message.replace(/`/g, "'")}\``);
      continue;
    }
    if (v.condition) {
      if (isHidden(v.condition)) continue;
      lines.push(`when \`${v.condition}\``);
      continue;
    }
    if (v.schema?.properties) {
      lines.push(`error object with fields: ${Object.keys(v.schema.properties).join(', ')}`);
      continue;
    }
    lines.push('generic error');
  }
  if (lines.length <= MAX_BULLETS) return lines;
  return [...lines.slice(0, MAX_BULLETS), `… (+${lines.length - MAX_BULLETS} more, see Examples)`];
}
