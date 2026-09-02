/**
 * What a file hands out as a shape, and where that shape's fields start.
 */

import ts from "typescript";
import { unique } from "#fp";

/** A named declaration whose fields the scan can look up. The name is
 * required, because every lookup starts from it. */
export type Shape = (
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
) & { name: ts.Identifier };

/** A class counts, because `SafeHtml.html` is reached like any other field.
 * An unnamed one cannot be looked up, so it is left out. */
export const isShape = (node: ts.Node): node is Shape =>
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  (ts.isClassDeclaration(node) && node.name !== undefined);

/** An export list names a symbol that stands for the declaration, so ask what
 * it stands for before it asks where the declaration was written down. */
export const standsFor = (
  checker: ts.TypeChecker,
  exported: ts.Symbol,
): ts.Symbol =>
  (exported.flags & ts.SymbolFlags.Alias) === 0
    ? exported
    : checker.getAliasedSymbol(exported);

/** Where a symbol was written down. Only this file counts, because a
 * re-export belongs to the file that declares it. */
const declaredIn = (symbol: ts.Symbol, file: string): ts.Declaration[] =>
  (symbol.declarations ?? []).filter(
    (declaration) => declaration.getSourceFile().fileName === file,
  );

/** Every shape a file lets other files reach. The checker answers this, not
 * the `export` keyword on the declaration. That also catches the seven
 * aliases of `settings-helpers.ts`. Those are declared plainly, and a list at
 * the foot of the file exports them. A namespace is a module too, so the walk
 * asks it in turn. */
export const exportedShapes = (
  checker: ts.TypeChecker,
  container: ts.Symbol,
  file: string,
  seen: Set<ts.Symbol> = new Set(),
): Shape[] => {
  // `namespace Wrapped { export import Self = Wrapped }` exports itself, and
  // the walk would follow that round for ever.
  if (seen.has(container)) return [];
  seen.add(container);
  const shapes: Shape[] = [];
  for (const exported of checker.getExportsOfModule(container)) {
    const symbol = standsFor(checker, exported);
    for (const declaration of declaredIn(symbol, file)) {
      if (isShape(declaration)) shapes.push(declaration);
      else if (ts.isModuleDeclaration(declaration)) {
        shapes.push(...exportedShapes(checker, symbol, file, seen));
      }
    }
  }
  // `export { Row, Row as PublicRow }` names one declaration twice, and a
  // second walk of it would count every field again.
  return unique(shapes);
};

/** What a shape is made of. Its type parameters stay out. A constraint such
 * as `<E extends { id: number }>` describes E, and `id` is no field of the
 * shape itself. */
export const shapeBody = (shape: Shape): readonly ts.Node[] =>
  ts.isTypeAliasDeclaration(shape) ? [shape.type] : shape.members;

export const inheritedTypesOf = (shape: Shape): readonly ts.Node[] => {
  if (ts.isTypeAliasDeclaration(shape)) return [];
  return shape.heritageClauses?.flatMap((clause) => clause.types) ?? [];
};

/** Whether a shape takes fields from somewhere else. An alias always does,
 * because anything it is made of can be a type it only names:
 * `StripeRefund = StripeRefundFields` names one, `Omit<Row, "id">` reshapes
 * one, and `PaymentSuccess | PaymentFailure` names two. */
export const inheritsFrom = (shape: Shape): boolean =>
  ts.isTypeAliasDeclaration(shape) ||
  ts.isClassDeclaration(shape) ||
  shape.heritageClauses !== undefined;
