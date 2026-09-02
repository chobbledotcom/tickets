/** Checker-resolved values that syntax-only utility types hide. */

import ts from "typescript";
import { answered } from "#scripts/unread-fields/host.ts";
import { fieldPath, shapeAround, writtenNames } from "./declarations.ts";
import type { FieldName } from "./names.ts";
import { standsFor } from "./shapes.ts";
import {
  type PathChange,
  type Step,
  throughResult,
  throughWay,
} from "./steps.ts";
import type {
  TryVisitType,
  VisitContext,
  VisitNode,
  VisitType,
  WalkState,
} from "./walk-state.ts";

const ELEMENT_TYPES = new Set(["Set", "ReadonlySet", "Record"]);
const MAP_TYPES = new Set(["Map", "ReadonlyMap"]);
const ASYNC_TYPES = new Set(["Promise", "PromiseLike"]);

const typeArgumentsOf = (
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] => {
  if (type.aliasTypeArguments) return type.aliasTypeArguments;
  // Every container the walk accepts — an array, a tuple, a set, a record, a
  // map, an async value — resolves to a type reference, so its arguments
  // are always there to read.
  return checker.getTypeArguments(type as unknown as ts.TypeReference);
};

const builtInNameOf = (type: ts.Type): string | undefined => {
  const reference = type as ts.TypeReference;
  const symbol = type.aliasSymbol ?? reference.target?.symbol ?? type.symbol;
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    )
    ? symbol?.name
    : undefined;
};

const acceptedBuiltInName = (
  type: ts.Type,
  names: ReadonlySet<string>,
): string | undefined => {
  const name = builtInNameOf(type);
  return name && names.has(name) ? name : undefined;
};

const isAcceptedBuiltIn =
  (names: ReadonlySet<string>): ((type: ts.Type) => boolean) =>
  (type) =>
    acceptedBuiltInName(type, names) !== undefined;

const parameterPath = (
  path: readonly Step[],
  declaration: ts.ParameterDeclaration,
  index: number,
): readonly Step[] => [
  ...path,
  {
    way: ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : String(index),
  },
];

export const createTypeVisitor = (
  context: VisitContext,
  visitNode: VisitNode,
): VisitType => {
  const { checker, isExportedTarget, remember } = context;
  const underElement = throughWay("[]");
  const typeNodesByTarget = new Map<
    ts.Symbol,
    ReadonlyMap<ts.Type, readonly ts.TypeNode[]>
  >();

  const typeNodesOf = (
    target: ts.Symbol,
  ): ReadonlyMap<ts.Type, readonly ts.TypeNode[]> => {
    const cached = typeNodesByTarget.get(target);
    if (cached) return cached;
    // The target a type walk starts from is the shape the walk was opened
    // for, so it always kept the declaration that named it.
    const declarations = answered(
      target.declarations,
      "the shape a type walk started from",
    );
    const nodes = new Map<ts.Type, ts.TypeNode[]>();
    const index = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) {
        const type = checker.getTypeAtLocation(node);
        const saved = nodes.get(type) ?? [];
        saved.push(node);
        nodes.set(type, saved);
      }
      ts.forEachChild(node, index);
    };
    for (const declaration of declarations) index(declaration);
    typeNodesByTarget.set(target, nodes);
    return nodes;
  };

  const visitWrittenType: TryVisitType = (path, type, state) => {
    const nodes = typeNodesOf(state.rootTarget).get(type) ?? [];
    for (const node of nodes) visitNode(path, node, state);
    return nodes.length > 0;
  };

  const entersAnotherExport = (name: FieldName, state: WalkState): boolean => {
    const holder = shapeAround(name);
    if (!holder) return false;
    // A shape's name is written where the checker can read it, so the symbol
    // is always there.
    const symbol = answered(
      checker.getSymbolAtLocation(holder.name),
      "the symbol of a shape's name",
    );
    const target = standsFor(checker, symbol);
    return target !== state.rootTarget && isExportedTarget(target);
  };

  type ArgumentPathAt = (index: number) => PathChange | undefined;

  const pathsByPlace =
    (paths: readonly PathChange[]): ArgumentPathAt =>
    (index) =>
      paths[index];

  const visitArguments =
    (
      accepts: (type: ts.Type) => boolean,
      pathAt: ArgumentPathAt,
    ): TryVisitType =>
    (path, type, state) => {
      if (!accepts(type)) return false;
      typeArgumentsOf(checker, type).forEach((argument, index) => {
        const changePath = pathAt(index);
        if (changePath) visitType(changePath(path), argument, state);
      });
      return true;
    };

  const visitTuple = visitArguments(
    checker.isTupleType.bind(checker),
    (index) => throughWay(String(index)),
  );

  const visitArray = visitArguments(
    checker.isArrayType.bind(checker),
    pathsByPlace([underElement]),
  );

  const visitElementContainer: TryVisitType = (path, type, state) => {
    const name = acceptedBuiltInName(type, ELEMENT_TYPES);
    if (!name) return false;
    if (name === "Record" && visitWrittenType(path, type, state)) return true;
    const value = typeArgumentsOf(checker, type).at(-1);
    if (value) visitType(underElement(path), value, state);
    return true;
  };

  const visitMap = visitArguments(
    isAcceptedBuiltIn(MAP_TYPES),
    pathsByPlace([throughWay("keys()"), throughWay("values()")]),
  );
  const visitAsyncType = visitArguments(
    isAcceptedBuiltIn(ASYNC_TYPES),
    pathsByPlace([throughResult]),
  );

  const visitTypeArguments: TryVisitType = (path, type, state) =>
    visitTuple(path, type, state) ||
    visitArray(path, type, state) ||
    visitElementContainer(path, type, state) ||
    visitMap(path, type, state) ||
    visitAsyncType(path, type, state);

  const visitSignature = (
    path: readonly Step[],
    signature: ts.Signature,
    way: "()" | "new ()",
    state: WalkState,
  ): void => {
    const callPath = throughWay(way)(path);
    signature.getParameters().forEach((parameter, index) => {
      // A signature's parameters keep the declaration and the name they were
      // written with. Only a checker-synthesized signature has none.
      const declaration = answered(
        parameter.valueDeclaration,
        "the declaration of a signature parameter",
      ) as ts.ParameterDeclaration;
      const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
      visitType(parameterPath(callPath, declaration, index), type, state);
    });
    visitType(
      throughResult(callPath),
      checker.getReturnTypeOfSignature(signature),
      state,
    );
  };

  const visitSignatures: VisitType = (path, type, state) => {
    for (const signature of checker.getSignaturesOfType(
      type,
      ts.SignatureKind.Call,
    )) {
      visitSignature(path, signature, "()", state);
    }
    for (const signature of checker.getSignaturesOfType(
      type,
      ts.SignatureKind.Construct,
    )) {
      visitSignature(path, signature, "new ()", state);
    }
  };

  const visitProperties: VisitType = (path, type, state) => {
    for (const property of checker.getPropertiesOfType(type)) {
      const names = writtenNames(property);
      const [firstName] = names;
      if (!firstName) continue;
      const value = checker.getTypeOfSymbolAtLocation(property, firstName);
      for (const name of names) {
        const inside =
          state.recordsFields && !entersAnotherExport(name, state)
            ? remember(path, name)
            : fieldPath(path, name);
        visitType(inside, value, state);
      }
    }
  };

  const visitType: VisitType = (path, type, state): void => {
    if (
      state.activeTypes.has(type) ||
      type.flags & ts.TypeFlags.TypeParameter
    ) {
      return;
    }
    const next = {
      ...state,
      activeTypes: new Set(state.activeTypes).add(type),
    };
    if (type.isUnion()) {
      for (const part of type.types) visitType(path, part, next);
      return;
    }
    if (visitTypeArguments(path, type, next)) return;
    visitSignatures(path, type, next);
    visitProperties(path, type, next);
  };

  return visitType;
};
