// Discovers three literal signals in a method body: events emitted with a
// string name, audit records carrying an `action:` literal, and a string that
// states the operation is an idempotent no-op.

import * as ts from 'typescript';
import { propValue, stringValue, type MethodFactAdapter } from '../method-facts';
import { EVIDENCE } from '../evidence';

export function signalMarkersAdapter(): MethodFactAdapter {
  return {
    name: 'signal-markers',
    onNode(node, ctx) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const chain = node.expression.getText();
        const [firstArg] = node.arguments;
        if (/\.(emit|publish)$/.test(chain) && stringValue(firstArg)) {
          ctx.add(ctx.info.emitted, stringValue(firstArg)!);
          ctx.evidence(node, EVIDENCE.eventEmit, { event: stringValue(firstArg) });
        }
        if (/audit/i.test(chain) && /\.(record|log)$/.test(chain) && firstArg && ts.isObjectLiteralExpression(firstArg)) {
          const action = stringValue(propValue(firstArg, 'action'));
          if (action) {
            ctx.add(ctx.info.auditActions, action);
            ctx.evidence(node, EVIDENCE.auditRecord, { action });
          }
        }
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && /idempotent|no-op/i.test(node.getText())) {
        ctx.info.idempotent = true;
        ctx.evidence(node, EVIDENCE.idempotenceMarker);
      }
    },
  };
}
