// Reads persistent-resource facts from decorator-based ORM classes
// (TypeORM `@Entity` / Mongoose `@Schema`). The engine only sees EntityFacts.

import * as ts from 'typescript';
import { evidenceAt, EVIDENCE } from '../evidence';
import type { EntityFacts, EntityField, SchemaProvider } from '../entity-facts';

export interface OrmConvention {
  classDecorators: string[];
  // Decorator that carries the table name as its first string argument.
  tableDecorator: string;
  relationDecorators: string[];
  softDeleteField: string;
  softDeleteDecorator: string;
  // Suffix of a document alias type (`FooDocument` -> schema class `Foo`).
  documentAliasSuffix: string;
  // `static <name> = { relations: [...] }`: related data embedded in responses.
  staticResponseProperty?: string;
}

export const DECORATOR_ORM: OrmConvention = {
  classDecorators: ['Entity', 'Schema'],
  tableDecorator: 'Entity',
  relationDecorators: ['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany'],
  softDeleteField: 'deletedAt',
  softDeleteDecorator: 'DeleteDateColumn',
  documentAliasSuffix: 'Document',
};

const decoratorName = (d: ts.Decorator): string => (ts.isCallExpression(d.expression) ? d.expression.expression.getText() : d.expression.getText());

function optionsOf(decorator: ts.Decorator): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  if (!ts.isCallExpression(decorator.expression)) return out;
  for (const arg of decorator.expression.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p)) out.set(p.name.getText(), p.initializer);
    }
  }
  return out;
}

export function ormSchemaProvider(conv: OrmConvention = DECORATOR_ORM): SchemaProvider {
  return {
    name: 'decorator-orm',
    entityClassNames(typeArg: string): string[] {
      const alias = new RegExp(`${conv.documentAliasSuffix}$`);
      return [typeArg, typeArg.replace(alias, '')];
    },
    readEntity(cls: ts.ClassLikeDeclaration): EntityFacts | undefined {
      const classDecorators = ts.getDecorators(cls) ?? [];
      if (!classDecorators.some((d) => conv.classDecorators.includes(decoratorName(d))) || !cls.name) return undefined;

      const facts: EntityFacts = { className: cls.name.text, fields: [], softDelete: false, responseRelations: [], evidence: [] };
      facts.evidence.push(evidenceAt(cls, EVIDENCE.entityDeclaration, { entity: cls.name.text }));
      const tableDecorator = classDecorators.find((d) => ts.isCallExpression(d.expression) && d.expression.expression.getText() === conv.tableDecorator);
      if (tableDecorator && ts.isCallExpression(tableDecorator.expression)) {
        const [first] = tableDecorator.expression.arguments;
        if (first && ts.isStringLiteralLike(first)) facts.table = first.text;
      }

      for (const member of cls.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const name = member.name.text;
        if (conv.staticResponseProperty && name === conv.staticResponseProperty && member.initializer && ts.isObjectLiteralExpression(member.initializer)) {
          for (const p of member.initializer.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText() === 'relations' && ts.isArrayLiteralExpression(p.initializer)) {
              facts.responseRelations = p.initializer.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
            }
          }
          continue;
        }
        if (name === conv.softDeleteField) {
          facts.softDelete = true;
          facts.evidence.push(evidenceAt(member, EVIDENCE.entityField, { field: name, marks: 'soft-delete' }));
        }

        const field: EntityField = { name, type: member.type?.getText() ?? 'unknown', optional: Boolean(member.questionToken), unique: false };
        for (const d of ts.getDecorators(member) ?? []) {
          const dName = decoratorName(d);
          if (dName === conv.softDeleteDecorator) {
            facts.softDelete = true;
            facts.evidence.push(evidenceAt(member, EVIDENCE.entityField, { field: name, marks: 'soft-delete' }));
          }
          if (conv.relationDecorators.includes(dName) && ts.isCallExpression(d.expression)) {
            const [target] = d.expression.arguments;
            const targetName = target && ts.isArrowFunction(target) ? target.body.getText() : undefined;
            field.relation = { kind: dName, target: targetName };
            facts.evidence.push(evidenceAt(member, EVIDENCE.entityRelation, { field: name, kind: dName, target: targetName }));
          }
          const opts = optionsOf(d);
          if (opts.get('unique')?.getText() === 'true') {
            field.unique = true;
            facts.evidence.push(evidenceAt(member, EVIDENCE.entityField, { field: name, unique: true }));
          }
          const nullable = opts.get('nullable')?.getText() === 'true' || opts.get('required')?.getText() === 'false';
          if (nullable) field.optional = true;
          const def = opts.get('default')?.getText();
          if (def !== undefined && !def.includes('=>')) {
            field.defaultValue = def;
            facts.evidence.push(evidenceAt(member, EVIDENCE.entityField, { field: name, default: def }));
          }
          const en = opts.get('enum')?.getText();
          if (en && /^[A-Z]\w*$/.test(en)) field.enumType = en;
        }
        facts.fields.push(field);
      }
      return facts;
    },
  };
}
