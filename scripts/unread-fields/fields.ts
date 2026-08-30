/**
 * What a file hands out, and which of its fields the scan can look up.
 *
 * A shape is a class, an interface or a type alias that `src/` exports. This
 * finds those, and walks each one for the fields a reader can reach.
 */

import ts from "typescript";
import { mapNotNullish } from "#fp";
import {
  exportedShapes,
  inheritsFrom,
  type Shape,
  shapeBody,
} from "./fields/shapes.ts";
import {
  type FieldName,
  isFieldName,
  type Step,
  stepText,
  underAnUnnamedPart,
} from "./fields/steps.ts";
import { membersOf } from "./fields/walking.ts";
import { reaching } from "./findings.ts";
import { carriesAModifier, quotedInBrackets } from "./writes.ts";

/** A member nobody outside the class can reach is not a field it hands out.
 * `private` and `protected` say so with a word, and `#name` says so with the
 * name itself. */
const keepsItToItself = carriesAModifier(
  ts.ModifierFlags.Private | ts.ModifierFlags.Protected,
);

const isHidden = (node: ts.Node): boolean => {
  const { name } = node as ts.NamedDeclaration;
  if (name && ts.isPrivateIdentifier(name)) return true;
  return keepsItToItself(node);
};

/** A member that hands nothing out, so a type written inside it is out of
 * reach too. `constructor(private options: { url: string })` is not one: the
 * word hides the field, and the constructor stays everyone's to call, so
 * `url` is still a caller's to supply. */
const handsNothingOut = (node: ts.Node): boolean =>
  isHidden(node) && !ts.isParameter(node);

/** A member the class carries rather than a value of it. `C.made` and
 * `held.made` are two fields, so the class object gets a name of its own:
 * `typeof C` is what TypeScript calls it. */
const isStatic = carriesAModifier(ts.ModifierFlags.Static);

/** A member that holds a field. Every member of a class or an interface does,
 * a method included: `send(value: { id: string })` puts `id` under `send`
 * rather than under the class. `SafeHtml` writes its one field as
 * `constructor(public html: string)`, which is a parameter and a field at
 * once. A plain constructor parameter is not one. */
const holdsAField = (node: ts.Node): node is ts.NamedDeclaration =>
  ts.isTypeElement(node) ||
  ts.isClassElement(node) ||
  (ts.isParameter(node) &&
    ts.isParameterPropertyDeclaration(node, node.parent));

/** The name a declaration is written down by. An index signature has none.
 * A setter has none either, for a different reason: `row.total = 1` calls it,
 * and the scan asks whether a value comes out. A getter beside it gives the
 * pair its one line, and a set-only accessor has no value to take out. */
const nameOf = (node: ts.Node): FieldName | undefined => {
  if (isHidden(node) || ts.isSetAccessorDeclaration(node)) return;
  const { name } = node as ts.NamedDeclaration;
  // `["foo"]: 1` declares the same field as `"foo": 1`, and the compiler
  // answers a lookup for `row.foo` with either.
  const written = name && (quotedInBrackets(name) ?? name);
  return written && isFieldName(written) ? written : undefined;
};

/** The same question asked of a shape's own syntax, where a node has to be a
 * member before its name is a field. The checker needs no such guard, because
 * it hands back properties and nothing else. */
const fieldNameOf = (node: ts.Node): FieldName | undefined =>
  holdsAField(node) ? nameOf(node) : undefined;

/** The types a shape hands fields on from. A union hands on the fields of
 * every arm, not the few they share: a reader of `Success | Failure` reaches
 * all of them once it knows which arm it holds. */
const partsOf = (type: ts.Type): readonly ts.Type[] =>
  type.isUnion() ? type.types : [type];

/** Every place a borrowed field is written down. A mapped type such as
 * `Partial<Listing>` makes up its properties, so some are written down nowhere
 * and the scan has no identifier to look up. A library's own members are
 * written down, but not by this repository: `Config["total"]` resolves to
 * `number`, which carries `toFixed`. */
const writtenNames = (property: ts.Symbol): FieldName[] =>
  mapNotNullish(nameOf)(
    (property.declarations ?? []).filter(
      (at) => !at.getSourceFile().isDeclarationFile,
    ),
  );

/** Where a shape's borrowed fields are written down.
 * `UntaggedPaymentReference` takes `reference` from a base its own file keeps
 * to itself, and `CheckoutIntent` intersects one. A reader of either reaches
 * those fields like any other. */
const inheritedNames = (checker: ts.TypeChecker, shape: Shape): FieldName[] =>
  inheritsFrom(shape)
    ? partsOf(checker.getTypeAtLocation(shape.name))
        .flatMap((part) => checker.getPropertiesOfType(part))
        .flatMap(writtenNames)
    : [];

/** One field the scan looked at, and the shape it belongs to. A field can be
 * written down in more than one place: both arms of a union declare it, and a
 * read points at whichever arm it holds. The first name says where a reader
 * has to go, and the rest are the other places a read can point at. */
export interface OwnedField {
  names: [FieldName, ...FieldName[]];
  owner: string;
}

/** The path a reader follows, written the way the code that follows it is. */
const ownerOf = (path: readonly Step[]): string =>
  path.map(stepText).reduce(reaching);

/** Every field an exported shape declares, with the fields of the object
 * types nested inside it, since `shape.inner.total` reaches those too. The
 * owner carries the path down to the field, so the two `dbConfigured` fields
 * of `DebugPageState` do not report as one line. */
export const exportedFields = (
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): OwnedField[] => {
  const container = checker.getSymbolAtLocation(source);
  if (!container) return [];
  const found = new Map<string, OwnedField>();
  /** Write one field down, and say what its own parts belong to. One field
   * deserves one line, because two lines could disagree, so a field already
   * written down keeps its line and gains any new place it is written. The
   * path stays a list of steps, because a field can be called `"a.b"`, and one
   * joined string would make it the `b` of an `a` instead. */
  const remember = (path: readonly Step[], name: FieldName): Step[] => {
    const inside: Step[] = [...path, { name: name.text }];
    const key = JSON.stringify(inside);
    const line = found.get(key);
    if (!line) found.set(key, { names: [name], owner: ownerOf(path) });
    // For every field a shape writes down itself, the checker hands back the
    // very declaration the walk already saw. One lookup answers for both.
    else if (!line.names.includes(name)) line.names.push(name);
    return inside;
  };

  const partsOf = membersOf(checker);
  const collect = (path: readonly Step[], node: ts.Node): void => {
    if (handsNothingOut(node)) return;
    const here: readonly Step[] = isStatic(node)
      ? [{ way: `typeof ${ownerOf(path)}` }]
      : path;
    const name = fieldNameOf(node);
    const inside = name ? remember(here, name) : underAnUnnamedPart(here, node);
    for (const child of partsOf(node)) collect(inside, child);
  };
  for (const shape of exportedShapes(checker, container, source.fileName)) {
    const from: Step[] = [{ name: shape.name.text }];
    for (const part of shapeBody(shape)) collect(from, part);
    // A borrowed field goes under the shape's own name, so a field the shape
    // declares itself already holds the line. It gains a second name only
    // where the checker hands back a second declaration, as `A & B` does.
    for (const name of inheritedNames(checker, shape)) {
      remember(from, name);
    }
  }
  return [...found.values()];
};
