// class-validator is an OPTIONAL peer: projects without it simply do not get
// validator-derived refinements / 400 messages. Loaded lazily and defensively.
interface MetadataStorageLike {
  getTargetValidationMetadatas(
    targetConstructor: Function,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): unknown[];
}

let cached: { getMetadataStorage: () => MetadataStorageLike } | null | undefined;

export function getValidatorMetadataStorage(): MetadataStorageLike | undefined {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('class-validator') as { getMetadataStorage: () => MetadataStorageLike };
    } catch {
      cached = null;
    }
  }
  try {
    return cached?.getMetadataStorage();
  } catch {
    return undefined;
  }
}
