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

/** The two ways a mention can name the field it reaches: after a dot, and
 * inside brackets. `row["total"]` reaches the same member as `row.total`. */
const reachesTheField = (node: ts.Node, parent: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
  (ts.isElementAccessExpression(parent) && parent.argumentExpression === node);

/** Both of the questions below are about the access that reaches the field,
 * so both put their question to that access the same way. */
const throughTheField =
  (ask: (access: ts.Node) => boolean) =>
  (node: ts.Node, parent: ts.Node): boolean =>
    reachesTheField(node, parent) && ask(parent);

/** A field an assignment writes into: `row.total = 1`, and the slot a pattern
 * fills, as in `({ value: row.total } = source)`. Both put a value in. */
const isAssignedProperty = throughTheField((access) => isAssignedTo(access));

/** `delete row.total` takes the field away. It never looks at the value, so
 * it is not a reader. */
const isDeletedProperty = throughTheField(
  (access) =>
    access.parent !== undefined && ts.isDeleteExpression(access.parent),
);

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

/** Every question below is put to one mention and answered yes or no. */
export type AskAboutAMention = (node: ts.Node) => boolean;

/** Every question here is about a node and the node above it, so a node with
 * nothing above it — a whole file — answers no before the question is put. */
const onParent =
  (ask: (node: ts.Node, parent: ts.Node) => boolean): AskAboutAMention =>
  (node) => {
    const parent = node.parent;
    return parent ? ask(node, parent) : false;
  };

/** Whether an assignment writes into this node, following the nesting of
 * `({ inner: { total } } = row)` out to the `=`. */
const isAssignedTo: AskAboutAMention = onParent((node, parent) => {
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  }
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
    return parent.initializer === node;
  }
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

/** True when this mention puts a value into the field. */
const isWrite: AskAboutAMention = onParent((node, parent) =>
  isDestructuringTarget(parent)
    ? false
    : WAYS_TO_WRITE.some((writes) => writes(node, parent)),
);

const isDeleted: AskAboutAMention = onParent(isDeletedProperty);

/** True when this mention names a member of something, after a dot or inside
 * brackets, rather than standing on its own as a plain name. */
export const namesAMember: AskAboutAMention = onParent(reachesTheField);

/** Put a question to a mention and to everything it sits inside, up to the
 * whole file. The compiler already climbs that chain, so this only turns the
 * node it stops on into a yes or a no. */
const anywhereAbove =
  (matches: AskAboutAMention): AskAboutAMention =>
  (node) =>
    ts.findAncestor(node, matches) !== undefined;

/** Whether a mention sits inside one particular piece of the program. Asking
 * the nodes themselves needs no file name and no character counting: a
 * mention in another file has none of that file's nodes above it. */
export const isInside = (whole: ts.Node): AskAboutAMention =>
  anywhereAbove((at) => at === whole);

/** A mention inside a type names the field to borrow its type, and no value
 * moves when the program runs. `Config["execute"]` is one. */
const isTypeOnly: AskAboutAMention = anywhereAbove(ts.isTypeNode);

/** True when this mention takes the value out of the field. `row.total` and
 * `const { total } = row` do. `{ total: 1 }`, `<Meter total={1} />`,
 * `delete row.total` and `Config["total"]` do not. */
export const readsTheValue: AskAboutAMention = (node) =>
  !(isWrite(node) || isDeleted(node) || isTypeOnly(node));
