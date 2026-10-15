// Discovers persistence writes (Mongoose / TypeORM style) on injected
// data-access receivers, and soft-delete filters on a configurable field.

import * as ts from 'typescript';
import { propValue, type DataWrite, type MethodFactAdapter } from '../method-facts';
import { EVIDENCE } from '../evidence';
import type { DescriptionConventions } from '../conventions';

export interface PersistenceConvention {
  // Suffixes (case-insensitive) of injected properties that are data access.
  receiverSuffixes: string[];
  // Column / property marking a record as soft-deleted.
  softDeleteField: string;
  // Technology words that carry no business meaning in a receiver's name.
  technologyWords: string[];
}
export const ORM_PERSISTENCE: PersistenceConvention = {
  receiverSuffixes: ['model', 'repository', 'repo', 'collection'],
  softDeleteField: 'deletedAt',
  technologyWords: ['model', 'repository', 'repo', 'redis', 'mongo', 'db'],
};

// What the description layer needs to know about this persistence style.
export const persistenceConventions = (conv: PersistenceConvention = ORM_PERSISTENCE): Pick<DescriptionConventions, 'softDeleteField' | 'dataAccessSuffixes' | 'technologyWords'> => ({
  softDeleteField: conv.softDeleteField,
  dataAccessSuffixes: conv.receiverSuffixes,
  technologyWords: conv.technologyWords,
});

const WRITE_OPS = /^(create|insertMany|insertOne|save|updateOne|updateMany|findByIdAndUpdate|findOneAndUpdate|deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete|remove|softDelete|softRemove|restore)$/;
const UPDATE_OPS = new Set(['updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate']);
const MONGO_OPERATORS = new Set(['$set', '$pull', '$push', '$addToSet', '$inc', '$unset']);

function usesInput(n: ts.Node, names: Set<string>): boolean {
  let hit = false;
  const walk = (m: ts.Node): void => {
    if (ts.isIdentifier(m) && names.has(m.text)) hit = true;
    ts.forEachChild(m, walk);
  };
  walk(n);
  return hit;
}

export function persistenceWriteAdapter(conv: PersistenceConvention = ORM_PERSISTENCE): MethodFactAdapter {
  const receiverRe = new RegExp(`(${conv.receiverSuffixes.join('|')})$`, 'i');
  const readWrite = (call: ts.CallExpression, callee: ts.PropertyAccessExpression): DataWrite | undefined => {
    const op = callee.name.text;
    const receiver = /^this\.(\w+)/.exec(callee.expression.getText())?.[1];
    if (!WRITE_OPS.test(op) || !receiver) return undefined;
    // `this.productsService.remove(...)` is a service call, not a persistence write.
    if (!receiverRe.test(receiver)) return undefined;
    const write: DataWrite = { receiver, op, set: {}, pulled: [], pushed: [], softDeletes: false };
    const doc = UPDATE_OPS.has(op) ? call.arguments[1] : undefined;
    if (doc && ts.isObjectLiteralExpression(doc)) {
      for (const p of doc.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = p.name.getText();
        if (!MONGO_OPERATORS.has(key)) {
          write.set[key] = p.initializer.getText();
          continue;
        }
        if (!ts.isObjectLiteralExpression(p.initializer)) continue;
        for (const inner of p.initializer.properties) {
          if (!ts.isPropertyAssignment(inner)) continue;
          const field = inner.name.getText();
          if (key === '$set') write.set[field] = inner.initializer.getText();
          else if (key === '$pull') write.pulled.push(field);
          else if (key === '$push' || key === '$addToSet') write.pushed.push(field);
        }
      }
    }
    write.softDeletes = op === 'softDelete' || conv.softDeleteField in write.set;
    return write;
  };
  // Names derived from the method's parameters (`data`, `const mapped = f(data)`).
  const inputNames = (method: ts.MethodDeclaration): Set<string> => {
    const names = new Set(method.parameters.map((p) => p.name.getText()));
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && usesInput(n.initializer, names)) names.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    if (method.body) visit(method.body);
    return names;
  };
  const inputCache = new WeakMap<ts.MethodDeclaration, Set<string>>();
  return {
    name: 'persistence-writes',
    onNode(node, ctx) {
      // Merge semantics: the input is copied onto an existing record (Object.assign / merge)
      // or applied through an update operator, so omitted fields are left as they were.
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText();
        const names = inputCache.get(ctx.method) ?? inputNames(ctx.method);
        inputCache.set(ctx.method, names);
        const assigns = callee === 'Object.assign' && node.arguments.slice(1).some((a) => usesInput(a, names));
        const merges = /\.merge$/.test(callee) && node.arguments.some((a) => usesInput(a, names));
        const receiver = ts.isPropertyAccessExpression(node.expression) ? /^this\.(\w+)/.exec(node.expression.expression.getText())?.[1] : undefined;
        const operator = ts.isPropertyAccessExpression(node.expression) && UPDATE_OPS.has(node.expression.name.text)
          && receiver !== undefined && receiverRe.test(receiver) && node.arguments[1] !== undefined && usesInput(node.arguments[1], names);
        if (assigns || merges || operator) {
          ctx.info.mergesInput = true;
          ctx.evidence(node, EVIDENCE.mergeInput, { call: callee });
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const write = readWrite(node, node.expression);
        if (write) {
          ctx.info.writes.push(write);
          ctx.evidence(node, EVIDENCE.persistenceWrite, { receiver: write.receiver, op: write.op });
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText() === conv.softDeleteField && node.initializer.kind === ts.SyntaxKind.NullKeyword) {
        ctx.info.filtersDeleted = true;
        ctx.evidence(node, EVIDENCE.softDeleteFilter, { field: conv.softDeleteField });
      }
    },
  };
}
