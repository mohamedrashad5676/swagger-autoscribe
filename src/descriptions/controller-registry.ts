import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { diagnostics } from './diagnostics';
import { walkFiles } from '../fs-utils';
import {
  SWAGGER_IGNORE_RE,
  leadingComments,
  readCtorTypes,
  readMethodInfo,
  type MethodFactAdapter,
  type MethodSourceInfo,
} from './method-facts';

const logger = diagnostics('ControllerRegistry');

export { SWAGGER_IGNORE_TAG } from './method-facts';
export type { MethodSourceInfo } from './method-facts';

export interface ControllerSourceInfo {
  filePath: string;
  ignored: boolean;
}

// Maps a controller class name to its source file and per-method source
// facts. `@Resource()`-free handlers need their declared return type resolved
// directly from that file's AST (see SourceSchemaExtractor.extractFromReturnType).
export class ControllerRegistry {
  private readonly fileByClassName = new Map<string, string>();
  private readonly controllers = new Map<string, ControllerSourceInfo>();
  private readonly methods = new Map<string, MethodSourceInfo>();
  // class name -> (constructor property name -> injected type name)
  private readonly ctorTypes = new Map<string, Map<string, string>>();
  private built = false;

  constructor(private readonly methodAdapters: readonly MethodFactAdapter[] = []) {}

  // Controllers are found by CONTENT (`@Controller(`), not by file name, so any
  // naming/layout convention works.
  build(srcRoots: string | string[]): void {
    if (this.built) return;
    this.built = true;
    const files: string[] = [];
    for (const root of Array.isArray(srcRoots) ? srcRoots : [srcRoots]) files.push(...this.findFiles(root));
    for (const file of files) this.scanFile(file);
    logger.log(`Indexed ${this.fileByClassName.size} controller classes from ${files.length} files`);
  }

  get(controllerClassName: string): string | undefined {
    return this.fileByClassName.get(controllerClassName);
  }

  allFiles(): string[] {
    return Array.from(new Set(this.fileByClassName.values()));
  }

  // Every scanned controller method (used for generic quality sweeps).
  allMethods(): { controllerClassName: string; methodName: string }[] {
    return Array.from(this.methods.keys()).map((k) => {
      const [controllerClassName, methodName] = k.split('.');
      return { controllerClassName, methodName };
    });
  }

  isControllerIgnored(controllerClassName: string): boolean {
    return this.controllers.get(controllerClassName)?.ignored ?? false;
  }

  getMethod(controllerClassName: string, methodName: string): MethodSourceInfo | undefined {
    return this.methods.get(`${controllerClassName}.${methodName}`);
  }

  // Type injected as `this.<prop>` into a controller's constructor.
  getDependencyType(controllerClassName: string, prop: string): string | undefined {
    return this.ctorTypes.get(controllerClassName)?.get(prop);
  }

  private findFiles(root: string): string[] {
    return walkFiles(root, {
      filter: (full, name) => {
        if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts') || /\.(spec|test|e2e-spec)\.tsx?$/.test(name)) return false;
        try {
          return fs.readFileSync(full, 'utf8').includes('@Controller');
        } catch {
          return false;
        }
      },
    });
  }

  scanFile(filePath: string, textOverride?: string): void {
    const text = textOverride ?? fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2023, true);

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        this.fileByClassName.set(className, filePath);
        this.controllers.set(className, {
          filePath,
          ignored: leadingComments(node, text).some((c) => SWAGGER_IGNORE_RE.test(c)),
        });

        this.ctorTypes.set(className, readCtorTypes(node));
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
          this.methods.set(`${className}.${member.name.text}`, readMethodInfo(member, text, this.methodAdapters));
        }
      }
    });
  }
}
