/**
 * Telling a mention that puts a value into a field from one that takes a
 * value out of it.
 *
 * This is the whole point of the scan. A field can be mentioned often and
 * still never be read: every mention writes it, and nothing downstream ever
 * looks. Counting mentions cannot see that. Counting reads can.
 */

import ts from "typescript";

/** The innermost node covering a position, which is the identifier a
 * reference points at. */
export const nodeAt = (
  source: ts.SourceFile,
  position: number,
): ts.Node | undefined => {
  const descend = (node: ts.Node): ts.Node | undefined => {
    if (node.getStart() > position || position >= node.getEnd()) {
      return;
    }
    return ts.forEachChild(node, descend) ?? node;
  };
  return ts.forEachChild(source, descend);
};

/** True when this mention puts a value into the field. `{ total: 1 }` and
 * `row.total = 1` write it. `row.total` and `const { total } = row` read it.
 * A shorthand `{ total }` writes the field from a variable of that name. */
export const isWrite = (node: ts.Node): boolean => {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) {
    return true;
  }
  if (ts.isPropertyAssignment(parent)) return parent.name === node;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return isAssignedProperty(node, parent);
};

/** `row.total = 1`, where the field sits on the left of an assignment. */
const isAssignedProperty = (node: ts.Node, parent: ts.Node): boolean =>
  ts.isPropertyAccessExpression(parent) &&
  parent.name === node &&
  ts.isBinaryExpression(parent.parent) &&
  parent.parent.left === parent &&
  parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
