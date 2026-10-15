// Regression tests for recursive nested-DTO schema resolution
// (SourceSchemaExtractor.extractWithRefs + the placeholder-then-fill
// registration pattern swagger.post-processor.ts's resolveDtoSchema uses).
//
// Uses REAL project DTOs wherever a real one demonstrates the case —
// CreateInvoicesDto/CreateInvoiceTaxNestedDto for direct + array nesting,
// UpdateUserAccountsDto/MembersDto/EntitlementValuesDto for 3-level real
// depth and multiple-nested-DTOs-on-one-parent. The one synthetic fixture
// (CircularCategoryDto) exists because no DTO in this codebase is
// self-referencing, but cycle safety is a correctness requirement that
// needs an actual cycle to exercise it.
import * as path from 'node:path';
import { SourceSchemaExtractor, type JsonSchema } from '../src/schema/source-schema-extractor';

const INVOICE = path.resolve(__dirname, 'fixtures/invoice.dto.ts');
const CIRCULAR_FIXTURE = path.resolve(__dirname, 'fixtures/circular.dto.ts');

// Mirrors resolveDtoSchema's real registration strategy: register a
// placeholder for a class BEFORE recursing into its properties, so a
// cyclic self-reference resolves to the (eventually complete) same object
// instead of recursing forever, and a class reached twice is resolved once.
function makeRegistryResolver(extractor: SourceSchemaExtractor, registry: Record<string, JsonSchema>) {
  const visited = new Set<string>();

  function resolve(filePath: string, className: string): JsonSchema {
    if (visited.has(className)) {
      return { $ref: `#/components/schemas/${className}` };
    }
    visited.add(className);

    const placeholder: JsonSchema = registry[className] ?? { type: 'object', properties: {} };
    registry[className] = placeholder;

    const structural = extractor.extractWithRefs(filePath, className, (nestedClassName, nestedSourceFile) =>
      resolve(nestedSourceFile.fileName, nestedClassName),
    );

    Object.assign(placeholder, structural);
    return { $ref: `#/components/schemas/${className}` };
  }

  return { resolve, registry };
}

describe('nested DTO resolution — direct nesting (real project DTO)', () => {
  it('CreateInvoicesDto.taxes[]/items[] resolve to $ref against registered nested schemas', () => {
    const extractor = new SourceSchemaExtractor({ cwd: process.cwd() });
    const file = INVOICE;
    extractor.initialize([file]);

    const { resolve, registry } = makeRegistryResolver(extractor, {});
    resolve(file, 'CreateInvoicesDto');

    const parent = registry['CreateInvoicesDto'];
    expect(parent.properties?.taxes).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/CreateInvoiceTaxNestedDto' },
    });
    expect(parent.properties?.items).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/CreateInvoiceItemNestedDto' },
    });

    // the nested schemas must actually exist, with real properties — not {}
    expect(registry['CreateInvoiceTaxNestedDto']).toBeDefined();
    expect(Object.keys(registry['CreateInvoiceTaxNestedDto'].properties ?? {}).length).toBeGreaterThan(0);
    expect(registry['CreateInvoiceItemNestedDto']).toBeDefined();
    expect(Object.keys(registry['CreateInvoiceItemNestedDto'].properties ?? {}).length).toBeGreaterThan(0);
  });

  it('resolves the real declared enum for a nested field even though its own decorator is @IsString(), not @IsEnum() — the whole point of reading source over validator metadata', () => {
    const extractor = new SourceSchemaExtractor({ cwd: process.cwd() });
    const file = INVOICE;
    extractor.initialize([file]);
    const { resolve, registry } = makeRegistryResolver(extractor, {});
    resolve(file, 'CreateInvoicesDto');

    expect(registry['CreateInvoiceTaxNestedDto'].properties?.taxType).toEqual({
      type: 'string',
      enum: ['PERCENTAGE', 'FIXED'],
    });
  });
});

describe('nested DTO resolution — multiple nested DTOs + real 3-level depth (real project DTO)', () => {
  it('UpdateUserAccountsDto has 4 independent nested-array properties, all resolved', () => {
    const extractor = new SourceSchemaExtractor({ cwd: process.cwd() });
    const file = INVOICE;
    extractor.initialize([file]);
    const { resolve, registry } = makeRegistryResolver(extractor, {});
    resolve(file, 'UpdateUserAccountsDto');

    const parent = registry['UpdateUserAccountsDto'];
    for (const [prop, target] of [
      ['members', 'MembersDto'],
      ['entitlements', 'EntitlementValuesDto'],
      ['usages', 'UsageValuesDto'],
      ['settings', 'SettingValueDto'],
    ] as const) {
      expect(parent.properties?.[prop]).toEqual({ type: 'array', items: { $ref: `#/components/schemas/${target}` } });
      expect(registry[target]).toBeDefined();
    }
  });

  it('resolves 3 real levels deep: UpdateUserAccountsDto -> MembersDto -> EntitlementValuesDto', () => {
    const extractor = new SourceSchemaExtractor({ cwd: process.cwd() });
    const file = INVOICE;
    extractor.initialize([file]);
    const { resolve, registry } = makeRegistryResolver(extractor, {});
    resolve(file, 'UpdateUserAccountsDto');

    // level 2: MembersDto itself has nested arrays
    const membersDto = registry['MembersDto'];
    expect(membersDto.properties?.entitlements).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/EntitlementValuesDto' },
    });
    expect(membersDto.properties?.settings).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/SettingValueDto' },
    });

    // level 3: EntitlementValuesDto is a real, populated leaf schema
    const leaf = registry['EntitlementValuesDto'];
    expect(leaf.type).toBe('object');
    expect(leaf.properties?.numericValue).toEqual({ type: 'number' });
    expect(leaf.properties?.periodStart).toEqual({ type: 'string', format: 'date-time' });
  });
});

describe('nested DTO resolution — circular reference (synthetic fixture)', () => {
  it('CircularCategoryDto.children: CircularCategoryDto[] terminates via reference tracking, not a depth limit', () => {
    const extractor = new SourceSchemaExtractor({ cwd: process.cwd() });
    extractor.initialize([CIRCULAR_FIXTURE]);
    const { resolve, registry } = makeRegistryResolver(extractor, {});

    // must return promptly — a real infinite loop would hang the test runner
    resolve(CIRCULAR_FIXTURE, 'CircularCategoryDto');

    const schema = registry['CircularCategoryDto'];
    expect(schema.type).toBe('object');
    expect(schema.properties?.name).toEqual({ type: 'string' });
    // the self-reference resolves to a $ref back to the same schema,
    // not a re-inlined copy and not an empty {}
    expect(schema.properties?.children).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/CircularCategoryDto' },
    });
    // exactly one schema was registered for the whole cycle, not one per
    // depth level
    expect(Object.keys(registry)).toEqual(['CircularCategoryDto']);
  });
});

