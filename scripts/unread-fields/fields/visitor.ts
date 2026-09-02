import ts from "typescript";
import { answered } from "#scripts/unread-fields/host.ts";
import {
  fieldNameOf,
  fieldPath,
  handsNothingOut,
  insideDeclaration,
  isStatic,
  onTheClass,
  referencedShapeBody,
  underAHeldClass,
} from "./declarations.ts";
import type { FieldName } from "./names.ts";
import { inheritedTypesOf, isShape, type Shape, standsFor } from "./shapes.ts";
import {
  fixedMembers,
  holdsAnAsyncResult,
  type Step,
  throughResult,
  underAnUnnamedPart,
} from "./steps.ts";
import { createTypeVisitor } from "./type-visitor.ts";
import type {
  PathAtNode,
  TryVisitNode,
  VisitContext,
  VisitNode,
  VisitType,
  WalkState,
} from "./walk-state.ts";
import { membersOf } from "./walking.ts";

export interface FieldVisitor {
  visit: VisitNode;
  visitType: VisitType;
}

type TypeReference = ts.TypeReferenceNode | ts.ExpressionWithTypeArguments;

const isTypeReference = (node: ts.Node): node is TypeReference =>
  ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node);

const referenceNameOf = (node: TypeReference): ts.EntityName | ts.Expression =>
  ts.isTypeReferenceNode(node) ? node.typeName : node.expression;

const shapesOf = (target: ts.Symbol): Shape[] =>
  (target.declarations ?? []).filter(
    (declaration): declaration is Shape =>
      !declaration.getSourceFile().isDeclarationFile && isShape(declaration),
  );

export const createFieldVisitor = (context: VisitContext): FieldVisitor => {
  const { checker, isExportedTarget, remember } = context;
  const partsOf = membersOf(checker);
  const fixedMembersOf = fixedMembers(checker);
  const stepOf = underAnUnnamedPart(checker);

  const enterField = (
    path: readonly Step[],
    name: FieldName,
    state: WalkState,
    symbol?: ts.Symbol,
  ): readonly Step[] =>
    state.recordsFields ? remember(path, name, symbol) : fieldPath(path, name);

  const pathAt: PathAtNode = (path, node, state) => {
    const heldClassPath = underAHeldClass(path, node);
    const here = heldClassPath ?? (isStatic(node) ? onTheClass(path) : path);
    const name = fieldNameOf(node);
    return name ? enterField(here, name, state) : stepOf(here, node);
  };

  const withArguments = (
    state: WalkState,
    shape: Shape,
    supplied: readonly ts.TypeNode[],
  ): ReadonlyMap<ts.Symbol, ts.TypeNode> => {
    const argumentsByParameter = new Map(state.argumentsByParameter);
    shape.typeParameters?.forEach((parameter, index) => {
      const argument = supplied[index] ?? parameter.default;
      if (!argument) return;
      const symbol = answered(
        checker.getSymbolAtLocation(parameter.name),
        `type parameter ${parameter.name.text}`,
      );
      argumentsByParameter.set(symbol, argument);
    });
    return argumentsByParameter;
  };

  const isBackEdge = (
    node: TypeReference,
    target: ts.Symbol,
    state: WalkState,
  ): boolean =>
    state.activeReferences.has(node) ||
    (state.activeTargets.has(target) &&
      insideDeclaration(node, state.currentTarget));

  const visitChildren: VisitNode = (path, node, state) => {
    for (const child of partsOf(node)) visit(path, child, state);
  };

  const visitFixed: TryVisitNode = (path, node, state) => {
    const fixed = fixedMembersOf(node);
    if (fixed === undefined) return false;
    for (const member of fixed) {
      visit(
        enterField(path, member.name, state, member.symbol),
        member.value,
        state,
      );
    }
    return true;
  };

  const visitAsyncResult: TryVisitNode = (path, node, state) => {
    if (!holdsAnAsyncResult(checker)(node)) return false;
    const [result] = (node as ts.TypeReferenceNode).typeArguments ?? [];
    visit(
      throughResult(path),
      answered(result, "asynchronous result type"),
      state,
    );
    return true;
  };

  const visitReferencedShape = (
    path: readonly Step[],
    shape: Shape,
    target: ts.Symbol,
    supplied: readonly ts.TypeNode[],
    state: WalkState,
  ): void => {
    const next: WalkState = {
      ...state,
      activeReferences: new Set(state.activeReferences),
      activeTargets: new Set(state.activeTargets).add(target),
      argumentsByParameter: withArguments(state, shape, supplied),
      currentTarget: target,
      recordsFields: state.recordsFields && !isExportedTarget(target),
    };
    for (const part of referencedShapeBody(shape)) visit(path, part, next);
    for (const base of inheritedTypesOf(shape)) visit(path, base, next);
  };

  const targetOfReference = (node: TypeReference): ts.Symbol | undefined => {
    const mentioned = checker.getSymbolAtLocation(referenceNameOf(node));
    return mentioned ? standsFor(checker, mentioned) : undefined;
  };

  const visitSuppliedReference = (
    path: readonly Step[],
    target: ts.Symbol,
    state: WalkState,
  ): boolean => {
    const supplied = state.argumentsByParameter.get(target);
    if (!supplied) return false;
    visit(path, supplied, {
      ...state,
      recordsFields:
        state.recordsFields ||
        !insideDeclaration(supplied, state.currentTarget),
    });
    return true;
  };

  const visitShapeReference = (
    path: readonly Step[],
    node: TypeReference,
    target: ts.Symbol,
    state: WalkState,
  ): boolean => {
    const shapes = shapesOf(target);
    if (shapes.length === 0) return false;
    if (isBackEdge(node, target, state)) return true;
    const activeReferences = new Set(state.activeReferences).add(node);
    const supplied = node.typeArguments ?? [];
    for (const shape of shapes) {
      visitReferencedShape(path, shape, target, supplied, {
        ...state,
        activeReferences,
      });
    }
    return true;
  };

  const visitReference = (
    path: readonly Step[],
    node: TypeReference,
    state: WalkState,
  ): boolean => {
    const target = targetOfReference(node);
    return (
      target !== undefined &&
      (visitSuppliedReference(path, target, state) ||
        visitShapeReference(path, node, target, state))
    );
  };

  const visit: VisitNode = (path, node, state) => {
    if (handsNothingOut(node)) return;
    const inside = pathAt(path, node, state);
    if (visitFixed(path, node, state)) return;
    if (visitAsyncResult(inside, node, state)) return;
    if (isTypeReference(node) && visitReference(inside, node, state)) return;
    visitChildren(inside, node, state);
  };

  const visitType = createTypeVisitor(context, visit);

  return { visit, visitType };
};
