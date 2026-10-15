// Types shared by the engine and its error scanners.

import type { JsonSchema } from '../schema/source-schema-extractor';
import type { Failure } from './error-reachability';

// One distinct throwable error discovered from a handler's reachable source.
// - status: from the framework exception class name, or an explicit status.
// - message: the first constructor argument WHEN it is a static string.
// - schema: when the first argument is an object literal, its keys.
export interface RuntimeErrorVariant {
  status: number;
  message?: string;
  messages?: string[];
  isTemplate?: boolean;
  templateRaw?: string;
  schema?: JsonSchema;
  isValidationPipe?: boolean;
  // Nearest enclosing `if (...)` condition, when the throw sits inside one.
  // Bare throws with no message are otherwise indistinguishable — the
  // condition is what makes each variant documentable.
  condition?: string;
  // Observed enclosing `if` condition / catch membership at the throw site
  // (always read when present, unlike `condition`, which only labels bare throws).
  when?: string;
  inCatch?: boolean;
  // Exception class name, when the failure is a constructed exception.
  kind?: string;
  // Call-graph depth at which the walk first reached this failure (0 = the handler itself).
  depth?: number;
  // The normalised failure this payload documents (set once the walk classified it).
  failure?: Failure;
}

export interface ErrorScanner {
  scanEndpoint(instance: object, methodName: string): RuntimeErrorVariant[];
  scanMethod(instance: object, methodName: string): RuntimeErrorVariant[];
}

// How a project's handlers reach other processes and where their sources live.
// Without it the scanner reads only the process it runs in.
export interface RuntimeScannerProfile {
  // Matches a call naming the remote target. Capture 1: remote service name,
  // capture 2: the service key its handlers are declared under.
  remoteTarget?: RegExp;
  // Matches the call invoking one remote method. Capture 1 or 2: method name.
  remoteCall?: RegExp;
  // Absolute source directory of a remote service, when it exists on disk.
  remoteSourceRoot(serviceName: string): string | undefined;
  // Absolute source directory of the package shared by every service.
  sharedSourceRoot(): string | undefined;
}

export const NEUTRAL_SCANNER: RuntimeScannerProfile = {
  remoteSourceRoot: () => undefined,
  sharedSourceRoot: () => undefined,
};
