import ts from "typescript";
import { mapNotNullish } from "#fp";
import {
  type PathFromNode,
  type Step,
  throughConstructedResult,
} from "#scripts/unread-fields/fields/steps.ts";
import { answered } from "#scripts/unread-fields/host.ts";
import { ownerPath } from "#scripts/unread-fields/identity.ts";
import {
  carriesAModifier,
  quotedInBrackets,
} from "#scripts/unread-fields/writes.ts";
import { type FieldName, fieldNameText, isFieldName } from "./names.ts";
import { isShape, type Shape, shapeBody } from "./shapes.ts";

const keepsItToItself = carriesAModifier(
  ts.ModifierFlags.Private | ts.ModifierFlags.Protected,
);

export const isHidden = (node: ts.Node): boolean => {
  const { name } = node as ts.NamedDeclaration;
  return Boolean(name && ts.isPrivateIdentifier(name)) || keepsItToItself(node);
};

export const handsNothingOut = (node: ts.Node): boolean =>
  isHidden(node) && !ts.isParameter(node);

export const isStatic = carriesAModifier(ts.ModifierFlags.Static);

const holdsAField = (node: ts.Node): node is ts.NamedDeclaration =>
  ts.isTypeElement(node) ||
  ts.isClassElement(node) ||
  (ts.isParameter(node) &&
    ts.isParameterPropertyDeclaration(node, node.parent));

export const nameOf = (node: ts.Node): FieldName | undefined => {
  if (isHidden(node) || ts.isSetAccessorDeclaration(node)) return;
  const { name } = node as ts.NamedDeclaration;
  const written = name && (quotedInBrackets(name) ?? name);
  return written && isFieldName(written) ? written : undefined;
};

export const fieldNameOf = (node: ts.Node): FieldName | undefined =>
  holdsAField(node) ? nameOf(node) : undefined;

export const writtenNames = (property: ts.Symbol): FieldName[] =>
  mapNotNullish(nameOf)(
    (property.declarations ?? []).filter(
      (at) => !at.getSourceFile().isDeclarationFile,
    ),
  );

export const fieldPath = (
  path: readonly Step[],
  name: FieldName,
): readonly Step[] => [...path, { name: fieldNameText(name) }];

/** The owner path of a shape is always the shape's own name, never a class's
 * shared path, so the prefix is added fresh every time. */
export const onTheClass = (path: readonly Step[]): readonly Step[] => {
  const text = ownerPath(path);
  return [{ way: `typeof ${text}` }];
};

export const referencedShapeBody = (shape: Shape): readonly ts.Node[] => {
  if (!ts.isClassDeclaration(shape)) return shapeBody(shape);
  const members = shape.members.filter(
    (member) => !isStatic(member) && !ts.isConstructorDeclaration(member),
  );
  const properties = shape.members
    .filter(ts.isConstructorDeclaration)
    .flatMap((constructorDeclaration) =>
      constructorDeclaration.parameters.filter(
        (parameter) =>
          ts.isParameterPropertyDeclaration(
            parameter,
            constructorDeclaration,
          ) && !isHidden(parameter),
      ),
    );
  return [...members, ...properties];
};

export const insideDeclaration = (node: ts.Node, symbol: ts.Symbol): boolean =>
  // The current target is the shape a reference was opened for, so its
  // declarations are always where the walk can find them.
  answered(symbol.declarations, "the current target's declarations").some(
    (declaration) =>
      declaration.getSourceFile() === node.getSourceFile() &&
      declaration.pos <= node.pos &&
      node.end <= declaration.end,
  );

export const underAHeldClass: PathFromNode<readonly Step[] | undefined> = (
  path,
  node,
) => {
  if (ts.isClassElement(node) && ts.isClassExpression(node.parent)) {
    return isStatic(node) || ts.isConstructorDeclaration(node)
      ? path
      : throughConstructedResult(path);
  }
  if (
    ts.isParameter(node) &&
    ts.isConstructorDeclaration(node.parent) &&
    ts.isClassExpression(node.parent.parent) &&
    ts.isParameterPropertyDeclaration(node, node.parent)
  ) {
    return throughConstructedResult(path);
  }
  return;
};

export const shapeAround = (node: ts.Node): Shape | undefined =>
  ts.findAncestor(node, isShape);
