/**
 * What a file hands out, and which of its fields the scan can look up.
 *
 * A shape is a class, an interface or a type alias that `src/` exports. This
 * finds those, and walks each one for the fields a reader can reach.
 */

import ts from "typescript";
import { filter, mapNotNullish, unique } from "#fp";
import { reaching } from "./findings.ts";
import { carriesAModifier, quotedInBrackets } from "./writes.ts";

/** A named declaration whose fields the scan can look up. The name is
 * required, because every lookup starts from it. */
type Shape = (
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
) & { name: ts.Identifier };

/** A class counts, because `SafeHtml.html` is reached like any other field.
 * An unnamed one cannot be looked up, so it is left out. */
const isShape = (node: ts.Node): node is Shape =>
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  (ts.isClassDeclaration(node) && node.name !== undefined);

/** An export list names a symbol that stands for the declaration, so ask what
 * it stands for before it asks where the declaration was written down. */
const standsFor = (checker: ts.TypeChecker, exported: ts.Symbol): ts.Symbol =>
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
const exportedShapes = (
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

/** One field the scan looked at, and the shape it belongs to. A field can be
 * written down in more than one place: both arms of a union declare it, and a
 * read points at whichever arm it holds. The first name says where a reader
 * has to go, and the rest are the other places a read can point at. */
export interface OwnedField {
  names: [FieldName, ...FieldName[]];
  owner: string;
}

/** What a shape is made of. Its type parameters stay out. A constraint such
 * as `<E extends { id: number }>` describes E, and `id` is no field of the
 * shape itself. */
const shapeBody = (shape: Shape): readonly ts.Node[] =>
  ts.isTypeAliasDeclaration(shape) ? [shape.type] : shape.members;

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
 * word hides the field, and the parameter stays part of the constructor
 * everyone calls, so `url` is still a caller's to supply. */
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

/** A field's name as it is written down. `row["status-code"]` reaches the
 * same member as `row.total`, so a quoted or numbered name counts, and so
 * does a template literal with nothing worked out in it: `` [`foo`]: number``
 * names the field `x.foo` exactly as `"foo": number` does. A `#private`
 * name is nobody else's to reach, so it is not a field the scan can look up.
 */
export type FieldName =
  | ts.Identifier
  | ts.StringLiteral
  | ts.NumericLiteral
  | ts.NoSubstitutionTemplateLiteral;

const isFieldName = (node: ts.Node): node is FieldName =>
  ts.isIdentifier(node) ||
  ts.isStringLiteral(node) ||
  ts.isNumericLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node);

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

/** Whether a shape takes fields from somewhere else. An alias always does,
 * because anything it is made of can be a type it only names:
 * `StripeRefund = StripeRefundFields` names one, `Omit<Row, "id">` reshapes
 * one, and `PaymentSuccess | PaymentFailure` names two. */
const inheritsFrom = (shape: Shape): boolean =>
  ts.isTypeAliasDeclaration(shape) ||
  ts.isClassDeclaration(shape) ||
  shape.heritageClauses !== undefined;

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

/** Four built-in types that keep some of the first argument and drop the
 * rest. `Extract` and `Exclude` choose arms of a union; `Pick` and `Omit`
 * choose keys of an object. Neither argument of any of them is the answer:
 * the second says what to keep and is nobody's to read, and the first still
 * holds what was dropped. Only the checker knows what is left, and it
 * resolves the reference for the shape it belongs to. Every other type
 * argument holds a type the shape hands on, as `Array<{ id: number }>` does. */
const NARROWS_BY_A_FILTER = new Set(["Extract", "Exclude", "Pick", "Omit"]);

/** A type this repository names rather than writes out, picked from a list. */
const namedOneOf =
  (names: ReadonlySet<string>): ((node: ts.Node) => boolean) =>
  (node) =>
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    names.has(node.typeName.text);

const narrowsByAFilter = namedOneOf(NARROWS_BY_A_FILTER);

/** The generics a reader reaches one member at a time. `Array<Row>` and
 * `Row[]` are one type written two ways, and `Record<string, Row>` is the
 * index signature written as a generic, which already takes this step. A set
 * holds many the same way, so a field of the shape and a field of what it
 * holds stay two fields. A map is not here: its two arguments are below. */
const holdsElements = namedOneOf(
  new Set(["Array", "ReadonlyArray", "Record", "Set", "ReadonlySet"]),
);

/** The generics that hold two different kinds of thing at once. The key and
 * the value of a map are reached by two different calls, so a field of each
 * with one name stays two fields. */
const holdsKeysAndValues = namedOneOf(new Set(["Map", "ReadonlyMap"]));

/** `keyof Row` names the words a shape's fields are called, not the fields. */
const isKeyOf = (node: ts.Node): boolean =>
  ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword;

/** Three ways to write a type none of whose parts is the answer. A filter
 * keeps some of its first argument, `keyof` names the words rather than the
 * fields, and `Row["paid"]` picks one key out of another type. The checker
 * knows what is left in each, and it answers for the shape that holds the
 * reference. */
const holdsNoAnswer = (node: ts.Node): boolean =>
  narrowsByAFilter(node) || isKeyOf(node) || ts.isIndexedAccessTypeNode(node);

/** The one arm a conditional answers with, when it has an answer. `true
 * extends true ? A : B` is only ever A, so no value of it holds a field of B.
 * A conditional that waits on a type parameter has no answer yet, and both
 * arms stay possible. A conditional that answers by substituting an `infer`
 * variable names its answer in neither arm — the true arm still denotes the
 * variable, and the checker hands back the substituted type — so the answer
 * is not a node to walk at all, and the checker path through the resolved
 * type is what carries the members. A conditional that distributes over a
 * union waits and answers at once, so its arms stay possible too. */
const answeredWith = (
  checker: ts.TypeChecker,
  node: ts.ConditionalTypeNode,
): ts.TypeNode | "resolved" | undefined => {
  const whole = checker.getTypeFromTypeNode(node);
  if (whole.flags & (ts.TypeFlags.Conditional | ts.TypeFlags.Union)) return;
  const arms = [node.trueType, node.falseType];
  return (
    arms.find((arm) => checker.getTypeFromTypeNode(arm) === whole) ?? "resolved"
  );
};

/** A node that holds a body and nothing a shape hands out. A static block is
 * one: it runs when the class is made, and the locals inside it are nobody
 * else's to reach. */
const holdsOnlyCode = (node: ts.Node): boolean =>
  ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);

/** Which of a node's parts can hold a member. A conditional checks one type
 * against another, and only the answer is part of the shape. A function keeps
 * its parameters and the type it hands back. Its body holds a type that never
 * leaves it, and its type parameters describe themselves, exactly as a
 * shape's own ones do. */
const worthWalking =
  (checker: ts.TypeChecker) =>
  (node: ts.Node): ((part: ts.Node) => boolean) => {
    // `keyof { paid: number }` is the one word "paid", not a shape with a
    // field, so nothing under it is a field either. `readonly` is a type
    // operator too, and `readonly { paid: number }[]` does hand `paid` out.
    if (holdsNoAnswer(node)) return () => false;
    if (ts.isConditionalTypeNode(node)) {
      const answer = answeredWith(checker, node);
      if (answer === "resolved") return () => false;
      if (answer) return (part) => part === answer;
      return (part) => part !== node.checkType && part !== node.extendsType;
    }
    if (!holdsOnlyCode(node)) return () => true;
    return (part) => ts.isTypeNode(part) || ts.isParameter(part);
  };

/** The parts of a node the walk goes on through. */
const membersOf =
  (checker: ts.TypeChecker) =>
  (node: ts.Node): ts.Node[] => {
    const parts: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      parts.push(child);
    });
    return filter(worthWalking(checker)(node))(parts);
  };

/** One step down to a field. A `name` is what a field is called, and a `way`
 * is how a reader reaches through a member with no name of its own. The two
 * are kept apart, because a field can be called `"()"` and a call is not one. */
type Step = { name: string } | { way: string };

const stepText = (step: Step): string =>
  "name" in step ? step.name : step.way;

/** The path a reader follows, written the way the code that follows it is. */
const ownerOf = (path: readonly Step[]): string =>
  path.map(stepText).reduce(reaching);

/** One element of something that holds many. An index signature and a list
 * both read this way, and a shape is never both at one place in the path. */
const ELEMENT = "[]";

/** How a reader reaches through a member that has no name to give. */
const REACHED_THROUGH: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.CallSignature, "()"],
  [ts.SyntaxKind.ConstructSignature, "new ()"],
  [ts.SyntaxKind.FunctionType, "()"],
  [ts.SyntaxKind.ConstructorType, "new ()"],
  [ts.SyntaxKind.IndexSignature, ELEMENT],
  [ts.SyntaxKind.ArrayType, ELEMENT],
  [ts.SyntaxKind.TupleType, ELEMENT],
  [ts.SyntaxKind.MappedType, ELEMENT],
]);

/** What a constructor's caller supplies an input through. */
const ENTERS_THROUGH = "new ()";

/** The type a call hands back and a caller receives. */
const ITS_RESULT = "result";

/** The step a caller's input to a constructor takes before its own name. The
 * parameters that arrive at `underAnUnnamedPart` are the inputs a caller
 * supplies — a plain one, or one a word hides — because a public parameter
 * property is a field and never walks. A method's parameter is nobody's
 * input, so only the constructor's take the step. */
const enterTheConstructorThrough = (
  node: ts.ParameterDeclaration,
): readonly { way: string }[] =>
  ts.isConstructorDeclaration(node.parent) ? [{ way: ENTERS_THROUGH }] : [];

/** The step a map's type arguments take apart. The key and the value are
 * reached by two different calls, `keys()` and `values()`, so the first
 * argument is the key's type. A reference that writes no arguments down has
 * none of either, and a map's name does not typecheck without its two. */
const throughTheMap = (node: ts.Node): { way: string } | undefined => {
  const { parent } = node;
  if (!ts.isTypeReferenceNode(parent)) return;
  const [key] = parent.typeArguments ?? [];
  if (!holdsKeysAndValues(parent)) return;
  return { way: node === key ? "keys()" : "values()" };
};

/** Whether a type node is the result its parent hands back. A call, a
 * construct, a method, an arrow, a getter: the type it returns is what a
 * caller receives, so it takes the `result` step. An index signature's type
 * is not one — it says what every value looks like, so it stays put. */
const handsBackItsResult = (node: ts.Node): boolean => {
  const { parent } = node;
  return (
    ts.isTypeNode(node) &&
    ts.isFunctionLike(parent) &&
    !ts.isIndexSignatureDeclaration(parent) &&
    parent.type === node
  );
};

/** The step a member with no name of its own adds to the path. A shape can
 * hold more than one of them, and each can carry a field of the same name, so
 * a step that tells them apart is what keeps the two fields two.
 * `send(first: { id: string }, second: { id: string })` is the plain case: the
 * parameter's own name does it. A destructured parameter has no name, so its
 * place in the list stands in. A call signature, a construct signature and an
 * index signature have neither, so the way a reader reaches through it does.
 * `bag[key].total` is a step away from `bag.total`, and without the step the
 * two are one field. A list is the same case: `rows[0].total` is a step away
 * from `rows.total`, so a list and a `Record` add one too.
 * A setter is a step of its own name, because a setter is nobody's to read
 * but its input is everybody's to supply. */
const underAnUnnamedPart = (
  path: readonly Step[],
  node: ts.Node,
): readonly Step[] => {
  if (ts.isParameter(node)) {
    const way = ts.isIdentifier(node.name)
      ? node.name.text
      : String(node.parent.parameters.indexOf(node));
    return [...path, ...enterTheConstructorThrough(node), { way }];
  }
  if (ts.isSetAccessorDeclaration(node)) {
    // A setter's name is written as a plain word, so it can say where the
    // input walks under. A computed one is worked out at run time, and the
    // walk stays where it was.
    const { name } = node;
    return ts.isIdentifier(name) ? [...path, { way: name.text }] : path;
  }
  const throughMap = throughTheMap(node);
  if (throughMap) return [...path, throughMap];
  if (handsBackItsResult(node)) return [...path, { way: ITS_RESULT }];
  const through = holdsElements(node)
    ? ELEMENT
    : REACHED_THROUGH.get(node.kind);
  return through === undefined ? path : [...path, { way: through }];
};

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
