import type { OpenAPIObject } from '@nestjs/swagger';
import { ControllerRegistry } from './controller-registry';
import { buildAutoProfile, autoConventions, type DescriptionOptions } from './auto-profile';
import { configureConventions, NEUTRAL_CONVENTIONS } from './conventions';
import { buildDescriptionDetailed } from './description-generator';
import { deriveContractFacts, type ContractFacts } from './contract-facts';
import { renderContract } from './contract-prose';
import { setLogSink } from './diagnostics';
import { isExcluded, type ExclusionOptions, type ExclusionReason, type ExclusionTarget } from './swagger-exclusion';
import { requestFactsOf, responseFactsOf } from './schema-facts';
import { ServiceChainIndex } from './service-chain';
import type { AutoDocLogger } from '../logger';

export interface DescribedOperation {
  controllerClassName: string;
  methodName: string;
  httpMethod: string;
  hasPagination: boolean;
  resourceName?: string;
  isPublic?: boolean;
  requiredPermissions?: string[];
  operationKey?: string;
}

/**
 * The description + exclusion machinery, bound to ONE application. Loaded lazily by the
 * enhancer because it needs the TypeScript compiler API.
 */
export class DescriptionEngine {
  private readonly registry: ControllerRegistry;
  private readonly chain: ServiceChainIndex;
  private built = false;

  constructor(
    private readonly cwd: string,
    private readonly entryRoots: string[],
    private readonly options: DescriptionOptions,
    logger: AutoDocLogger,
  ) {
    setLogSink((level, context, message) => (level === 'warn' ? logger.warn(`[${context}] ${message}`) : logger.debug(`[${context}] ${message}`)));
    const profile = buildAutoProfile(cwd, entryRoots, options);
    this.registry = new ControllerRegistry(profile.methodAdapters);
    this.chain = new ServiceChainIndex(this.registry, profile);
  }

  /** Controllers (for `@swagger-ignore`) are always indexed; the service chain only when descriptions are on. */
  build(withChain: boolean): void {
    if (!this.built) {
      this.built = true;
      configureConventions({ ...NEUTRAL_CONVENTIONS, ...autoConventions(this.options) });
      this.registry.build(this.entryRoots);
    }
    if (withChain) this.chain.build(this.entryRoots);
  }

  excludedBecause(target: ExclusionTarget, options: ExclusionOptions): ExclusionReason | undefined {
    return isExcluded(target, options, this.registry);
  }

  describe(document: OpenAPIObject, operation: Record<string, any>, op: DescribedOperation): string | undefined {
    const chain = this.chain.resolve(op.controllerClassName, op.methodName);
    const params: { name: string; in: string }[] = operation.parameters ?? [];
    const detailed = (this.options.detail ?? 'full') === 'full';
    const contract: ContractFacts | undefined = detailed
      ? deriveContractFacts(document, operation, {
          isPublic: op.isPublic ?? false,
          requiredPermissions: op.requiredPermissions ?? [],
          hasPagination: op.hasPagination,
          sourceFile: this.registry.get(op.controllerClassName),
          operationKey: op.operationKey ?? `${op.controllerClassName}.${op.methodName}`,
        })
      : undefined;

    let lead: string | undefined;
    if (chain.steps.length > 0) {
      const built = buildDescriptionDetailed({
        controllerClassName: op.controllerClassName,
        methodName: op.methodName,
        httpMethod: op.httpMethod,
        steps: chain.steps,
        crud: chain.crud,
        entity: chain.entity,
        hasPagination: op.hasPagination,
        resourceName: op.resourceName,
        pathParams: params.filter((p) => p.in === 'path').map((p) => p.name),
        queryParams: params.filter((p) => p.in === 'query').map((p) => p.name),
        request: requestFactsOf(document, operation),
        response: responseFactsOf(document, operation),
      });
      lead = built.text;
      // The source proves nothing about WHAT it does — but the response contract may still say what it returns.
      if (built.fallback && contract) lead = this.responseLead(contract, op.httpMethod, built.noun) ?? lead;
    } else if (contract) {
      lead = this.responseLead(contract, op.httpMethod, '');
    }
    if (!lead && !contract) return undefined;
    const detail = contract ? renderContract(contract, this.options.sections) : '';
    if (!lead && !detail) return undefined;
    this.lastFactCount = contract?.facts.length ?? 0;
    return [lead, this.fold(detail)].filter(Boolean).join('\n\n');
  }

  // Swagger UI renders descriptions with a Markdown renderer that passes `<details>` through (DOMPurify only
  // forbids style/form). The opening tag and <summary> sit on ONE line: a line break between them becomes a
  // <br> that would stop <summary> from being the first child, and the toggle would lose its label. The blank
  // line after it makes the renderer treat everything inside as Markdown again.
  private fold(detail: string): string {
    const collapse = this.options.collapse ?? true;
    if (!detail || collapse === false) return detail;
    const label = (typeof collapse === 'string' ? collapse : 'Contract details').replace(/[<>&]/g, '');
    return `<details><summary>${label}</summary>\n\n${detail}\n\n</details>`;
  }

  /** Number of evidenced contract facts behind the last description (for reporting). */
  lastFactCount = 0;

  private responseLead(contract: ContractFacts, httpMethod: string, noun: string): string | undefined {
    if (!/^(get|head)$/i.test(httpMethod)) return undefined;
    const ok = contract.responses.find((r) => r.fields.length > 0);
    if (!ok) return undefined;
    const names = ok.fields.slice(0, 4).map((f) => f.name);
    const what = noun ? `the ${noun} data` : 'the requested data';
    return `Returns ${ok.list ? `a list of ${noun || 'items'}` : what}, including ${names.join(', ')}${ok.fields.length > 4 ? ', and other details' : ''}.`;
  }
}
