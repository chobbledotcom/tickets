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

/** `row.total = 1`, where the field sits on the left of an assignment. */
const isAssignedProperty = (node: ts.Node, parent: ts.Node): boolean =>
  ts.isPropertyAccessExpression(parent) &&
  parent.name === node &&
  ts.isBinaryExpression(parent.parent) &&
  parent.parent.left === parent &&
  parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;

type Holder = ts.Node & { name?: ts.Node };

/** A mention is a write when it is the *name* of the thing that declares or
 * supplies the field. Anything else under that same thing is the value, and a
 * value can itself be a read: `class Sum { total = other }` reads `other`. */
const named =
  <T extends Holder>(is: (node: ts.Node) => node is T) =>
  (node: ts.Node, parent: ts.Node): boolean =>
    is(parent) && parent.name === node;

/** Every way a mention can put a value into a field. `<Meter total={1} />`
 * supplies one as surely as `{ total: 1 }` does, and `get total()` supplies
 * one from a class. A mention matching none of these takes the value out. */
const WAYS_TO_WRITE = [
  named(ts.isPropertySignature),
  named(ts.isPropertyDeclaration),
  named(ts.isMethodSignature),
  named(ts.isMethodDeclaration),
  named(ts.isGetAccessorDeclaration),
  named(ts.isSetAccessorDeclaration),
  named(ts.isPropertyAssignment),
  named(ts.isShorthandPropertyAssignment),
  named(ts.isJsxAttribute),
  isAssignedProperty,
];

/** Every question here is about a node and the node above it, so a node with
 * nothing above it — a whole file — answers no before the question is put. */
const onParent =
  (ask: (node: ts.Node, parent: ts.Node) => boolean) =>
  (node: ts.Node): boolean => {
    const parent = node.parent;
    return parent ? ask(node, parent) : false;
  };

/** Whether this literal is what an assignment writes into, following the
 * nesting of `({ inner: { total } } = row)` out to the `=`. */
const isAssignedTo: (node: ts.Node) => boolean = onParent((node, parent) => {
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  }
  if (ts.isForOfStatement(parent)) return parent.initializer === node;
  if (ts.isPropertyAssignment(parent)) return isAssignedTo(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return isAssignedTo(parent);
  return false;
});

/** `({ total } = row)` and `({ total: t } = row)` are built out of the same
 * nodes as `{ total: 1 }`, so they look like writes. They are reads: the
 * object literal around them is a pattern, not a value. */
const isDestructuringTarget = (parent: ts.Node): boolean =>
  (ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent)) &&
  isAssignedTo(parent.parent);

/** True when this mention puts a value into the field. `{ total: 1 }`,
 * `row.total = 1` and `<Meter total={1} />` write it. `row.total` and
 * `const { total } = row` read it. */
export const isWrite: (node: ts.Node) => boolean = onParent((node, parent) =>
  isDestructuringTarget(parent)
    ? false
    : WAYS_TO_WRITE.some((writes) => writes(node, parent)),
);
