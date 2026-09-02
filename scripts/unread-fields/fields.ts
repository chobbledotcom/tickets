/** The exported fields that the scanner can ask TypeScript about. */

import ts from "typescript";
import { answered } from "#scripts/unread-fields/host.ts";
import { type BorrowedField, borrowedFields } from "./fields/borrowed.ts";
import { fieldPath, onTheClass, shapeAround } from "./fields/declarations.ts";
import {
  type FieldName,
  fieldNameText,
  isNegativeNumericName,
} from "./fields/names.ts";
import {
  exportedShapes,
  inheritedTypesOf,
  type Shape,
  shapeBody,
  standsFor,
} from "./fields/shapes.ts";
import type { Step } from "./fields/steps.ts";
import { createFieldVisitor, type FieldVisitor } from "./fields/visitor.ts";
import type {
  RememberField,
  VisitContext,
  WalkState,
} from "./fields/walk-state.ts";

export interface OwnedField {
  names: [FieldName, ...FieldName[]];
  owner: readonly Step[];
  symbols: ts.Symbol[];
}

interface FieldStore {
  has: (path: readonly Step[], name: FieldName) => boolean;
  remember: RememberField;
  values: () => OwnedField[];
}

type ShapeTarget = (shape: Shape) => ts.Symbol;

interface ExportWalk {
  checker: ts.TypeChecker;
  isExportedTarget: (target: ts.Symbol) => boolean;
  store: FieldStore;
  targetOfShape: ShapeTarget;
  visitor: FieldVisitor;
}

const fieldKey = (path: readonly Step[], name: FieldName): string =>
  JSON.stringify(fieldPath(path, name));

const symbolOfNegativeName = (
  checker: ts.TypeChecker,
  name: FieldName,
): ts.Symbol | undefined => {
  if (!isNegativeNumericName(name)) return;
  return answered(
    checker.getSymbolAtLocation(name.parent),
    `property ${fieldNameText(name)}`,
  );
};

const addFieldDetails = (
  field: OwnedField,
  name: FieldName,
  symbol: ts.Symbol | undefined,
): void => {
  if (!field.names.includes(name)) field.names.push(name);
  if (symbol && !field.symbols.includes(symbol)) field.symbols.push(symbol);
};

const createFieldStore = (checker: ts.TypeChecker): FieldStore => {
  const found = new Map<string, OwnedField>();
  const has = (path: readonly Step[], name: FieldName): boolean =>
    found.get(fieldKey(path, name))?.names.includes(name) ?? false;
  const remember: RememberField = (path, name, symbol) => {
    const fieldSymbol = symbol ?? symbolOfNegativeName(checker, name);
    const key = fieldKey(path, name);
    const saved = found.get(key);
    if (!saved) {
      found.set(key, {
        names: [name],
        owner: [...path],
        symbols: fieldSymbol ? [fieldSymbol] : [],
      });
    } else {
      addFieldDetails(saved, name, fieldSymbol);
    }
    return fieldPath(path, name);
  };
  return { has, remember, values: () => [...found.values()] };
};

const createExportedTargetLookup = (
  checker: ts.TypeChecker,
  targetOfShape: ShapeTarget,
): ((target: ts.Symbol) => boolean) => {
  const targetsByFile = new Map<ts.SourceFile, ReadonlySet<ts.Symbol>>();
  const targetsOf = (file: ts.SourceFile): ReadonlySet<ts.Symbol> => {
    const cached = targetsByFile.get(file);
    if (cached) return cached;
    const container = checker.getSymbolAtLocation(file);
    const targets = new Set(
      container
        ? exportedShapes(checker, container, file.fileName).map(targetOfShape)
        : [],
    );
    targetsByFile.set(file, targets);
    return targets;
  };
  // A target the walk asks about always kept a declaration: it stands for a
  // name the compiler resolved, or for a shape the walk itself started from.
  return (target) =>
    answered(target.declarations, "the declarations of a walked target").some(
      (declaration) => targetsOf(declaration.getSourceFile()).has(target),
    );
};

const shapeTarget =
  (checker: ts.TypeChecker): ShapeTarget =>
  (shape) =>
    standsFor(
      checker,
      answered(
        checker.getSymbolAtLocation(shape.name),
        `shape ${shape.name.text}`,
      ),
    );

const belongsToAnotherExport = (
  walk: ExportWalk,
  rootTarget: ts.Symbol,
  node: ts.Node,
): boolean => {
  const holder = shapeAround(node);
  if (!holder) return false;
  const holderTarget = walk.targetOfShape(holder);
  return holderTarget !== rootTarget && walk.isExportedTarget(holderTarget);
};

const usesShapeParameter = (walk: ExportWalk, name: FieldName): boolean => {
  const holder = shapeAround(name);
  if (!holder?.typeParameters) return false;
  const parameters = new Set(
    holder.typeParameters.map((parameter) =>
      answered(
        walk.checker.getSymbolAtLocation(parameter.name),
        `type parameter ${parameter.name.text}`,
      ),
    ),
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    const symbol = walk.checker.getSymbolAtLocation(node);
    if (symbol && parameters.has(symbol)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(name.parent);
  return found;
};

interface BorrowedVisit extends BorrowedField {
  covered: boolean;
  name: FieldName;
}

const borrowedVisits = (
  store: FieldStore,
  owner: readonly Step[],
  fields: readonly BorrowedField[],
): BorrowedVisit[] =>
  fields.flatMap((field) =>
    field.names.map((name) => ({
      ...field,
      covered: store.has(owner, name),
      name,
    })),
  );

const visitBorrowedFields = (
  walk: ExportWalk,
  owner: readonly Step[],
  rootTarget: ts.Symbol,
  state: WalkState,
  fields: readonly BorrowedField[],
): void => {
  for (const field of borrowedVisits(walk.store, owner, fields)) {
    const fromAnotherExport = belongsToAnotherExport(
      walk,
      rootTarget,
      field.name,
    );
    const inside = fromAnotherExport
      ? fieldPath(owner, field.name)
      : walk.store.remember(owner, field.name);
    if (!field.covered) {
      walk.visitor.visitType(inside, field.value, {
        ...state,
        recordsFields:
          state.recordsFields &&
          (!fromAnotherExport || usesShapeParameter(walk, field.name)),
      });
    }
  }
};

const visitBorrowedSignatures = (
  walk: ExportWalk,
  owner: readonly Step[],
  state: WalkState,
  signatures: readonly ts.SignatureDeclaration[],
): void => {
  for (const signature of signatures) {
    walk.visitor.visit(owner, signature, {
      ...state,
      recordsFields:
        state.recordsFields &&
        !belongsToAnotherExport(walk, state.rootTarget, signature),
    });
  }
};

const visitShape = (walk: ExportWalk, shape: Shape): void => {
  const owner: Step[] = [{ name: shape.name.text }];
  const target = walk.targetOfShape(shape);
  const state: WalkState = {
    activeReferences: new Set(),
    activeTargets: new Set([target]),
    activeTypes: new Set(),
    argumentsByParameter: new Map(),
    currentTarget: target,
    recordsFields: true,
    rootTarget: target,
  };
  for (const part of shapeBody(shape)) walk.visitor.visit(owner, part, state);
  for (const base of inheritedTypesOf(shape)) {
    walk.visitor.visit(owner, base, state);
  }
  const borrowed = borrowedFields(walk.checker, shape);
  visitBorrowedFields(walk, owner, target, state, borrowed.onItsValues);
  visitBorrowedFields(
    walk,
    onTheClass(owner),
    target,
    state,
    borrowed.onTheClass,
  );
  visitBorrowedSignatures(walk, owner, state, borrowed.signatures);
};

/** Create one source-file scanner with shared checker caches. */
export const exportedFields = (
  checker: ts.TypeChecker,
): ((source: ts.SourceFile) => OwnedField[]) => {
  const targetOfShape = shapeTarget(checker);
  const isExportedTarget = createExportedTargetLookup(checker, targetOfShape);
  return (source) => {
    const container = checker.getSymbolAtLocation(source);
    if (!container) return [];
    const store = createFieldStore(checker);
    const context: VisitContext = {
      checker,
      isExportedTarget,
      remember: store.remember,
    };
    const visitor = createFieldVisitor(context);
    const walk = {
      checker,
      isExportedTarget,
      store,
      targetOfShape,
      visitor,
    };
    for (const shape of exportedShapes(checker, container, source.fileName)) {
      visitShape(walk, shape);
    }
    return store.values();
  };
};
