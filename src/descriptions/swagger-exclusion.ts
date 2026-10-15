// Single decision point for "is this endpoint hidden from Swagger?".
// Comment-based (`@swagger-ignore`) and config-based exclusion both flow
// through isExcluded(), so they behave identically downstream.
//
// Precedence (highest first):
//   1. `@swagger-ignore` comment on the controller or method
//   2. excludeControllers / excludeEndpoints config
//   3. manual Swagger docs (@ApiOperation description is never overwritten)
//   4. automatic generation
// 1 and 2 remove the operation from the document before any generation pass
// runs, so no automatic metadata can be re-added to it.

export interface ExclusionOptions {
  excludeControllers: string[];
  excludeEndpoints: string[];
}

export interface ExclusionTarget {
  controllerClassName: string;
  methodName: string;
  // lowercase HTTP verb
  method: string;
  // full route, e.g. '/user-accounts/:id'
  fullPath: string;
}

export interface SourceIgnoreLookup {
  isControllerIgnored(controllerClassName: string): boolean;
  getMethod(controllerClassName: string, methodName: string): { ignored: boolean } | undefined;
}

export type ExclusionReason =
  | 'comment:controller'
  | 'comment:endpoint'
  | 'config:controller'
  | 'config:endpoint';

export function normalizeRoute(route: string): string {
  let r = route.replace(/\{(\w+)\}/g, ':$1').replace(/\/+/g, '/');
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r.startsWith('/') ? r : `/${r}`;
}

// Ids: 'Controller.method' | 'VERB:/route' | 'Controller.VERB:/route'
export function matchesEndpointId(id: string, t: ExclusionTarget): boolean {
  const trimmed = id.trim();
  const dot = trimmed.indexOf('.');
  const colon = trimmed.indexOf(':');
  const verb = t.method.toUpperCase();
  const route = normalizeRoute(t.fullPath);

  const hasVerbRoute = colon > 0 && trimmed.slice(colon + 1).startsWith('/');
  if (!hasVerbRoute) {
    return trimmed === `${t.controllerClassName}.${t.methodName}`;
  }
  const controllerPart = dot > 0 && dot < colon ? trimmed.slice(0, dot) : undefined;
  const verbPart = trimmed.slice(controllerPart ? dot + 1 : 0, colon).toUpperCase();
  const routePart = normalizeRoute(trimmed.slice(colon + 1));
  if (controllerPart && controllerPart !== t.controllerClassName) return false;
  return verbPart === verb && routePart === route;
}

export function isExcluded(
  target: ExclusionTarget,
  options: ExclusionOptions,
  source: SourceIgnoreLookup,
): ExclusionReason | undefined {
  if (source.isControllerIgnored(target.controllerClassName)) return 'comment:controller';
  if (source.getMethod(target.controllerClassName, target.methodName)?.ignored) {
    return 'comment:endpoint';
  }
  if (options.excludeControllers.includes(target.controllerClassName)) return 'config:controller';
  if (options.excludeEndpoints.some((id) => matchesEndpointId(id, target))) return 'config:endpoint';
  return undefined;
}
