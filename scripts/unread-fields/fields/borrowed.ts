import ts from "typescript";
import { unique } from "#fp";
import { answered } from "#scripts/unread-fields/host.ts";
import { isStatic, nameOf, writtenNames } from "./declarations.ts";
import { type FieldName, fieldNameText } from "./names.ts";
import { inheritsFrom, type Shape } from "./shapes.ts";

export interface BorrowedField {
  names: FieldName[];
  value: ts.Type;
}

export interface BorrowedFields {
  onItsValues: BorrowedField[];
  onTheClass: BorrowedField[];
  signatures: ts.SignatureDeclaration[];
}

const partsOf = (type: ts.Type): readonly ts.Type[] =>
  type.isUnion() ? type.types : [type];

const writtenSignatures = (
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.SignatureDeclaration[] =>
  unique(
    [ts.SignatureKind.Call, ts.SignatureKind.Construct]
      .flatMap((kind) => checker.getSignaturesOfType(type, kind))
      .map((signature) =>
        answered(signature.getDeclaration(), "borrowed signature declaration"),
      )
      .filter((declaration) => !declaration.getSourceFile().isDeclarationFile),
  );

const fieldsFrom = (
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): BorrowedField[] =>
  partsOf(type).flatMap((part) =>
    checker.getPropertiesOfType(part).flatMap((property) => {
      const names = writtenNames(property);
      return names.length === 0
        ? []
        : [
            {
              names,
              value: checker.getTypeOfSymbolAtLocation(property, location),
            },
          ];
    }),
  );

export const borrowedFields = (
  checker: ts.TypeChecker,
  shape: Shape,
): BorrowedFields => {
  if (!inheritsFrom(shape)) {
    return { onItsValues: [], onTheClass: [], signatures: [] };
  }
  const type = checker.getTypeAtLocation(shape.name);
  const onItsValues = fieldsFrom(checker, type, shape);
  const signatures = partsOf(type).flatMap((part) =>
    writtenSignatures(checker, part),
  );
  if (!ts.isClassDeclaration(shape) || !shape.heritageClauses) {
    return { onItsValues, onTheClass: [], signatures };
  }
  const shadowed = new Set(
    shape.members
      .filter(isStatic)
      .map(nameOf)
      .filter((name): name is FieldName => name !== undefined)
      .map(fieldNameText),
  );
  const onTheClass = shape.heritageClauses
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types)
    .flatMap((base) =>
      fieldsFrom(
        checker,
        checker.getTypeAtLocation(base.expression),
        base.expression,
      ),
    )
    .filter((field) =>
      field.names.every((name) => !shadowed.has(fieldNameText(name))),
    );
  return { onItsValues, onTheClass, signatures };
};
