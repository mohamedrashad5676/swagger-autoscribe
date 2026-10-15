import { getValidatorMetadataStorage } from '../class-validator';

// Structural view of class-validator's ValidationMetadata — only the
// fields this module reads. (The class is not exported from the package
// root in every class-validator version, so no type import.)
interface ValidationMetadataView {
  type: string;
  name?: string;
  propertyName: string;
  constraints?: unknown[];
  message?: string | ((args: Record<string, unknown>) => unknown);
  groups?: string[];
  constraintCls?: new () => { defaultMessage?: (args: Record<string, unknown>) => unknown };
}

// Derives realistic ValidationPipe 400 messages for ONE endpoint from the
// runtime class-validator metadata of its @Body() DTO class — e.g.
// `@IsEmail() email` yields "email must be an email", `@MinLength(8)`
// yields "password must be longer than or equal to 8 characters".
//
// Why metadata instead of hardcoded examples: a global example ("property
// email should not exist") is wrong on every endpoint whose DTO has no
// email field. Reading the DTO's own validators makes the documented 400
// specific to the request it belongs to, on ANY NestJS project — the only
// inputs are the live DTO class and the pipe's forbidNonWhitelisted flag,
// both discovered at runtime by the caller.
//
// Fidelity notes (all mirror real ValidationPipe behavior):
// - custom `message:` strings are used verbatim ($property/$constraintN
//   tokens substituted; function messages invoked with fake args,
//   falling back to the default template when they throw).
// - @IsOptional() (conditionalValidation) never fails on its own — skipped.
// - grouped validators are skipped (a global pipe validates groupless).
// - @ValidateNested() children serialize as OBJECTS inside message[], not
//   strings — skipped here; the array schema still admits them.
// - whitelist "property X should not exist" names the offending (unknown)
//   prop, which can't be enumerated — represented by one neutral message
//   only when forbidNonWhitelisted is actually enabled and nothing else
//   was derived.
const MAX_MESSAGES = 10;

// class-validator's own default messages per validation type (types are
// the ValidationTypes values stored in metadata.type).
const DEFAULT_TEMPLATES: Record<string, string> = {
  isDefined: '$property should not be null or undefined',
  isNotEmpty: '$property should not be empty',
  equals: '$property must be equal to $constraint1',
  notEquals: '$property should not be equal to $constraint1',
  isEmpty: '$property must be empty',
  isIn: '$property must be one of the following values: $constraint1',
  isNotIn: '$property should not be one of the following values: $constraint1',
  isBoolean: '$property must be a boolean value',
  isDate: '$property must be a Date instance',
  isString: '$property must be a string',
  isNumber: '$property must be a number conforming to the specified constraints',
  isInt: '$property must be an integer number',
  isArray: '$property must be an array',
  isEnum: '$property must be a valid enum value',
  isDivisibleBy: '$property must be divisible by $constraint1',
  isPositive: '$property must be a positive number',
  isNegative: '$property must be a negative number',
  min: '$property must not be less than $constraint1',
  max: '$property must not be greater than $constraint1',
  minDate: 'minimal allowed date for $property is $constraint1',
  maxDate: 'maximal allowed date for $property is $constraint1',
  minLength: '$property must be longer than or equal to $constraint1 characters',
  maxLength: '$property must be shorter than or equal to $constraint1 characters',
  length: '$property must be longer than or equal to $constraint1 and shorter than or equal to $constraint2 characters',
  contains: '$property must contain a $constraint1 string',
  notContains: '$property should not contain a $constraint1 string',
  isAlpha: '$property must contain only letters (a-zA-Z)',
  isAlphanumeric: '$property must contain only letters and numbers',
  isAscii: '$property must contain only ASCII characters',
  isBase32: '$property must be base32 encoded',
  isBase64: '$property must be base64 encoded',
  isBooleanString: '$property must be a boolean string',
  isBtcAddress: '$property must be a BTC address',
  isByteLength: "$property's byte length must fall into ($constraint1, $constraint2) range",
  isCreditCard: '$property must be a credit card',
  isCurrency: '$property must be a currency',
  isDataURI: '$property must be a data uri format',
  isDateString: '$property must be a valid ISO 8601 date string',
  isEmail: '$property must be an email',
  isEthereumAddress: '$property must be an Ethereum address',
  isFQDN: '$property must be a valid domain name',
  isFullWidth: '$property must contain a full-width characters',
  isHSL: '$property must be a HSL color',
  isHalfWidth: '$property must contain a half-width characters',
  isHash: '$property must be a hash of type $constraint1',
  isHexColor: '$property must be a hexadecimal color',
  isHexadecimal: '$property must be a hexadecimal number',
  isIBAN: '$property must be an IBAN',
  isIP: '$property must be an ip address',
  isISBN: '$property must be an ISBN',
  isISIN: '$property must be an ISIN (stock/security identifier)',
  isISO8601: '$property must be a valid ISO 8601 date string',
  isISRC: '$property must be an ISRC',
  isISSN: '$property must be a ISSN',
  isIdentityCard: '$property must be a valid identity card number',
  isJSON: '$property must be a valid JSON string',
  isJWT: '$property must be a jwt string',
  isLocale: '$property must be locale',
  isLowercase: '$property must be a lowercase string',
  isMACAddress: '$property must be a MAC Address',
  isMagnetURI: '$property must be magnet uri format',
  isMilitaryTime: '$property must be a valid representation of military time in the format HH:MM',
  isMongoId: '$property must be a mongodb id',
  isMultibyte: '$property must contain one or more multibyte chars',
  isNumberString: '$property must be a number string',
  isOctal: '$property must be valid octal',
  isPassportNumber: '$property must be valid passport number',
  isPhoneNumber: '$property must be a valid phone number',
  isPort: '$property must be a port',
  isPostalCode: '$property must be a postal code',
  isRFC3339: '$property must be a valid RFC 3339 date',
  isRgbColor: '$property must be RGB color',
  isSemVer: '$property must be a Semantic Versioning Specification',
  isStrongPassword: '$property is not strong enough',
  isSurrogatePair: '$property must contain any surrogate pairs chars',
  isTimeZone: '$property must be a valid IANA time-zone',
  isUppercase: '$property must be uppercase',
  isUrl: '$property must be a URL address',
  isUUID: '$property must be a UUID',
  isVariableWidth: '$property must contain a variable-width characters',
  matches: '$property must match $constraint1 regular expression',
  arrayContains: '$property must contain $constraint1 values',
  arrayNotContains: '$property should not contain $constraint1 values',
  arrayMinSize: '$property must contain at least $constraint1 elements',
  arrayMaxSize: '$property must contain no more than $constraint1 elements',
  arrayNotEmpty: '$property should not be empty',
  arrayUnique: "All $property's elements must be unique",
  isInstance: '$property must be an instance of $constraint1',
  isObject: '$property must be an object',
  isNotEmptyObject: '$property must be a non-empty object',
};

export function deriveValidationMessages(
  dtoClass: Function,
  options?: { forbidNonWhitelisted?: boolean },
): string[] {
  const messages: string[] = [];
  const seen = new Set<string>();
  const push = (message: string): void => {
    if (!message || seen.has(message) || messages.length >= MAX_MESSAGES) return;
    seen.add(message);
    messages.push(message);
  };

  let metadatas: ValidationMetadataView[] | undefined;
  const storage = getValidatorMetadataStorage();
  if (!storage) return messages;
  try {
    metadatas = storage.getTargetValidationMetadatas(
      dtoClass as never,
      '',
      true,
      false,
      undefined,
    ) as unknown as ValidationMetadataView[] | undefined;
  } catch {
    return messages;
  }

  for (const meta of metadatas ?? []) {
    // A global ValidationPipe validates without groups.
    if (meta.groups && meta.groups.length > 0) continue;
    // @IsOptional() passes on absent values — never an error by itself.
    if (meta.type === 'conditionalValidation') continue;
    // Nested failures serialize as objects, not strings — out of scope.
    if (meta.type === 'nestedValidation') continue;
    // Whitelist violations name the unknown prop — not enumerable here.
    if (meta.type === 'whitelistValidation') continue;
    if (!meta.propertyName) continue;

    const rendered = renderMessage(dtoClass, meta);
    if (rendered) push(rendered);
  }

  if (messages.length === 0 && options?.forbidNonWhitelisted) {
    push('Request body contains disallowed properties');
  }
  return messages;
}

function renderMessage(dtoClass: Function, meta: ValidationMetadataView): string | undefined {
  const property = meta.propertyName;
  const constraints = meta.constraints ?? [];
  const fakeArgs = {
    value: undefined,
    constraints,
    targetName: (dtoClass as { name?: string }).name ?? '',
    property,
    object: {},
  };

  // 1. Explicit custom message on the decorator — exactly what the pipe
  //    would print (same precedence as the real ValidationExecutor).
  if (typeof meta.message === 'string' && meta.message.length > 0) {
    return substitute(meta.message, dtoClass, property, constraints);
  }
  if (typeof meta.message === 'function') {
    try {
      const rendered = (meta.message as (args: Record<string, unknown>) => unknown)(fakeArgs);
      if (typeof rendered === 'string' && rendered.length > 0) return rendered;
    } catch {
      // Custom message functions may assume a real value — fall through.
    }
  }

  // 2. The constraint class's own defaultMessage() — class-validator's
  //    real template for this validator ($property/$constraint1 tokens
  //    intact), resolved the same way the executor resolves it.
  const ConstraintCls = meta.constraintCls;
  if (ConstraintCls) {
    try {
      const instance = new ConstraintCls();
      if (typeof instance.defaultMessage === 'function') {
        const template = instance.defaultMessage(fakeArgs);
        if (typeof template === 'string' && template.length > 0) {
          return substitute(template, dtoClass, property, constraints);
        }
      }
    } catch {
      // defaultMessage() implementations may dereference the value.
    }
  }

  // 3. Name-keyed fallback (mirrors class-validator's documented defaults).
  const name = meta.name ?? meta.type;
  const template = DEFAULT_TEMPLATES[name] ?? `$property failed ${name} validation`;
  return substitute(template, dtoClass, property, constraints);
}

function substitute(template: string, dtoClass: Function, property: string, constraints: unknown[]): string {
  const constraint = (index: number): string => {
    const value = constraints?.[index];
    if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
    if (value instanceof RegExp) return String(value);
    if (value !== undefined && typeof value === 'object' && value !== null) {
      return (value as { name?: unknown }).name !== undefined ? String((value as { name?: unknown }).name) : '';
    }
    return value === undefined ? '' : String(value);
  };
  return template
    .replace(/\$property/g, property)
    .replace(/\$target/g, dtoClass.name ?? '')
    .replace(/\$constraint1/g, constraint(0))
    .replace(/\$constraint2/g, constraint(1))
    .replace(/\$value/g, `<${property}>`);
}
