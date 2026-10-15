// Discovers RPC facts in NestJS-style sources: a decorator names the rpc a
// method serves, and `client.<Rpc>` calls name the rpc being invoked.

import * as ts from 'typescript';
import { stringValue, type MethodFactAdapter } from '../method-facts';
import { EVIDENCE } from '../evidence';

export function rpcSourceAdapter(options: { handlerDecorator: string; clientReceiver: string } = { handlerDecorator: 'GrpcMethod', clientReceiver: 'client' }): MethodFactAdapter {
  // `(client as any)` / `client!` / `(client)` -> `client`.
  const unwrap = (node: ts.Expression): ts.Expression => {
    let cur = node;
    while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    return cur;
  };
  return {
    name: 'rpc-source',
    onMethod(ctx) {
      for (const d of ts.getDecorators(ctx.method) ?? []) {
        if (ts.isCallExpression(d.expression) && d.expression.expression.getText() === options.handlerDecorator) {
          ctx.info.handlesRpc = stringValue(d.expression.arguments[1]);
          ctx.evidence(d, EVIDENCE.rpcCall, { handles: ctx.info.handlesRpc });
        }
      }
    },
    onNode(node, ctx) {
      if (ts.isPropertyAccessExpression(node) && unwrap(node.expression).getText() === options.clientReceiver && /^[A-Z]/.test(node.name.text)) {
        ctx.add(ctx.info.rpcCalls, node.name.text);
        ctx.evidence(node, EVIDENCE.rpcCall, { rpc: node.name.text });
      }
    },
  };
}
