// Discovers "this operation acts for the authenticated caller" from the way a
// request object or a parameter decorator exposes the caller.

import * as ts from 'typescript';
import type { MethodFactAdapter } from '../method-facts';
import { EVIDENCE } from '../evidence';

export interface IdentityConvention {
  requestNames: string[];
  property: string;
  paramDecorators: string[];
}
export const REQUEST_USER: IdentityConvention = { requestNames: ['req', 'request'], property: 'user', paramDecorators: ['CurrentUser', 'AuthUser'] };

export function identitySourceAdapter(conv: IdentityConvention = REQUEST_USER): MethodFactAdapter {
  const names = conv.requestNames.join('|');
  const optional = new RegExp(`\\b(?:${names})\\??\\.${conv.property}\\b`);
  const strict = new RegExp(`\\b(?:${names})\\.${conv.property}\\b`);
  const decorator = new RegExp(`^(${conv.paramDecorators.join('|')})\\b`);
  return {
    name: 'identity-source',
    onNode(node, ctx) {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && optional.test(node.initializer.getText())) {
        ctx.add(ctx.info.authUserProps, node.name.text);
        ctx.evidence(node, EVIDENCE.actorBoundProperty, { prop: node.name.text });
      }
    },
    onFinish(ctx) {
      // An optional identity alone (public endpoints) only counts when the
      // handler rejects a missing caller.
      const body = ctx.method.body?.getText() ?? '';
      const viaParam = ctx.method.parameters.some((p) => (ts.getDecorators(p) ?? []).some((d) => decorator.test(d.expression.getText())));
      ctx.info.usesAuthUser = strict.test(body) || (optional.test(body) && ctx.info.throws.length > 0) || viaParam;
      if (ctx.info.usesAuthUser) ctx.evidence(ctx.method, EVIDENCE.actorUse, { via: viaParam ? 'parameter-decorator' : 'request' });
    },
  };
}
