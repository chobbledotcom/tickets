/**
 * Which mentions put a value into a field, and which take one out.
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

/** The node above, with any parentheses around it stepped over. Parentheses
 * are the only wrapper a delete allows: `delete row.total!` and
 * `delete (row.total as unknown)` are both refused, because the operand of a
 * delete has to be a property reference. */
const aboveTheParens = (node: ts.Node): ts.Node | undefined => {
  let at = node.parent;
  while (at && ts.isParenthesizedExpression(at)) at = at.parent;
  return at;
};

/** `delete row.total` takes the field away, and so does `delete (row.total)`.
 * Neither looks at the value, so neither is a reader. */
const isDeletedProperty = throughTheField((access) => {
  const above = aboveTheParens(access);
  return above !== undefined && ts.isDeleteExpression(above);
});

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

/** Whether a declaration was written with one of these words. `static`,
 * `declare`, `private` and `protected` are all modifiers. The answer covers
 * the declaration alone, so a `declare` above it does not travel down. */
export const carriesAModifier =
  (flags: ts.ModifierFlags): ((node: ts.Node) => boolean) =>
  (node) =>
    (ts.getCombinedModifierFlags(node as ts.Declaration) & flags) !== 0;

/** Every question below is put to one mention and answered yes or no. */
export type AskAboutAMention = (node: ts.Node) => boolean;

/** The quoted or numbered name inside a pair of brackets, when that is what
 * the brackets hold. `["total"]` and `[7]` name the same fields `"total"` and
 * `7` do. Brackets holding anything else — a variable, a sum, a symbol — work
 * their name out when the program runs, so nothing can look that name up. */
export const quotedInBrackets = (name: ts.Node): ts.Node | undefined => {
  if (!ts.isComputedPropertyName(name)) return;
  const { expression } = name;
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)
    ? expression
    : undefined;
};

/** The brackets a mention sits inside, when the mention is the name they
 * hold. A property is joined to the brackets rather than to the name inside
 * them, so only the brackets sit where the thing that holds the field can see
 * them. `[row.total]` is not this case: there the mention is a value the
 * brackets read, and it stands for itself. */
const inBrackets = (node: ts.Node): ts.Node => {
  const { parent } = node;
  return parent && quotedInBrackets(parent) === node ? parent : node;
};

/** Every question here is about a node and the node above it, so a node with
 * nothing above it — a whole file — answers no before the question is put. A
 * name in brackets stands for its brackets, because `["total"]: 1` supplies
 * the field exactly as `total: 1` does. */
const onParent =
  (ask: (node: ts.Node, parent: ts.Node) => boolean): AskAboutAMention =>
  (node) => {
    const mention = inBrackets(node);
    const parent = mention.parent;
    return parent ? ask(mention, parent) : false;
  };

/** Five ways to wrap a value that change nothing when the program runs, so
 * each can sit between the field and the `=`: `(row.total) = 1`,
 * `row.total! = 1`, `(row.total as number) = 1`, the same with `satisfies`,
 * and `(<number>row.total) = 1`. All five write the field. The last one needs
 * its parentheses, because `<number>row.total = 1` does not parse. */
const WRAPPERS_THAT_DO_NOTHING: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

const onlyWraps = (node: ts.Node): boolean =>
  WRAPPERS_THAT_DO_NOTHING.has(node.kind);

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
  // A rest element sits between the field and the literal that holds it, so
  // `[...row.total] = source` writes the field the same way `[row.total]` does.
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isSpreadElement(parent)
  ) {
    return isAssignedTo(parent.parent);
  }
  if (ts.isArrayLiteralExpression(parent)) return isAssignedTo(parent);
  if (onlyWraps(parent)) return isAssignedTo(parent);
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

/** The two object-literal nodes a destructuring assignment is built from. */
const NAMES_AN_ASSIGNED_SLOT = [
  named(ts.isPropertyAssignment),
  named(ts.isShorthandPropertyAssignment),
];

/** The third way to name a member is to let a pattern take it out, and a
 * pattern names the field it reaches on its left. `const { total } = row`
 * reaches it through a binding element, and `const { total: sum } = row`
 * names `total` there and binds `sum`. `({ total } = row)` reaches it through
 * the object-literal nodes an assignment pattern is built from instead. */
const namedByAPattern = (node: ts.Node, parent: ts.Node): boolean =>
  ts.isBindingElement(parent)
    ? parent.propertyName === node || parent.name === node
    : isDestructuringTarget(parent) &&
      NAMES_AN_ASSIGNED_SLOT.some((names) => names(node, parent));

/** True when this mention names a member of something rather than standing on
 * its own as a plain name. */
export const namesAMember: AskAboutAMention = onParent(
  (node, parent) =>
    reachesTheField(node, parent) || namedByAPattern(node, parent),
);

/** Put a question to a mention and to everything it sits inside, up to the
 * whole file. The compiler already climbs that chain, so this only turns the
 * node it stops on into a yes or a no. A question answers "quit" to stop the
 * climb where it stands. */
const anywhereAbove =
  (matches: (at: ts.Node) => boolean | "quit"): AskAboutAMention =>
  (node) =>
    ts.findAncestor(node, matches) !== undefined;

/** Whether a mention sits inside one particular piece of the program. Asking
 * the nodes themselves needs no file name and no character counting: a
 * mention in another file has none of that file's nodes above it. */
export const isInside = (whole: ts.Node): AskAboutAMention =>
  anywhereAbove((at) => at === whole);

const saysDeclare = carriesAModifier(ts.ModifierFlags.Ambient);

/** A class the program never builds, because the declaration only describes
 * one that exists somewhere else. `declare class` is the plain form. A class
 * inside a `declare namespace` is one too, and so is every declaration in a
 * `.d.ts` file. The walk up is what catches those two: a modifier flag is
 * combined with the declaration's own list and with nothing above it, so the
 * namespace's `declare` never reaches the class it holds. */
const isAmbient = (node: ts.Node): boolean =>
  node.getSourceFile().isDeclarationFile ||
  ts.findAncestor(node, saysDeclare) !== undefined;

/** `class Child extends registry.Base {}` reads `registry.Base` to find the
 * class to build on, and that read happens when the program runs. An
 * interface's `extends`, and every `implements`, name a type and read
 * nothing. Neither does an ambient class: it describes a class rather than
 * builds one, so nothing evaluates what it extends. */
const isRuntimeHeritage = (node: ts.Node): boolean =>
  ts.isExpressionWithTypeArguments(node) &&
  ts.isHeritageClause(node.parent) &&
  node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
  ts.isClassLike(node.parent.parent) &&
  !isAmbient(node.parent.parent);

/** A name in brackets that the compiler works out and the program never runs.
 * `interface Uses { [Registry.key]: string }` is one, and so is a member of a
 * class the program never builds. An object literal and a real class both work
 * their key out when they run, so neither is one. */
const namesAMemberNothingRuns = (node: ts.Node): boolean =>
  ts.isComputedPropertyName(node) &&
  (ts.isTypeElement(node.parent) || isAmbient(node));

/** A mention inside a type names the field to borrow its type, and no value
 * moves when the program runs. `Config["execute"]` is one. The compiler counts
 * a heritage clause as a type, so the climb stops before it. */
const isTypeOnly: AskAboutAMention = anywhereAbove((at) =>
  isRuntimeHeritage(at)
    ? "quit"
    : ts.isTypeNode(at) || namesAMemberNothingRuns(at),
);

/** True when this mention takes the value out of the field. `row.total` and
 * `const { total } = row` do. `{ total: 1 }`, `<Meter total={1} />`,
 * `delete row.total` and `Config["total"]` do not. */
export const readsTheValue: AskAboutAMention = (node) =>
  !(isWrite(node) || isDeleted(node) || isTypeOnly(node));
