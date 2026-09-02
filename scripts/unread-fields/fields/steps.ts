/**
 * The step a path takes through a member with no name of its own, and the
 * tables the spellings of a shape come from. A step is what keeps two
 * declarations that share a name two fields.
 */
import ts from "typescript";
import { answered } from "#scripts/unread-fields/host.ts";
import { quotedInBrackets } from "#scripts/unread-fields/writes.ts";
import { type FieldName, fieldNameText, isFieldName } from "./names.ts";

type TypeQuestion = (checker: ts.TypeChecker) => (node: ts.Node) => boolean;

/** Whether the language itself wrote a declaration down — in a declaration
 * file — rather than this repository. */
const declaredByTheLanguage = (at: ts.Declaration): boolean =>
  at.getSourceFile().isDeclarationFile;

/** A built-in type this reference names, picked from a list. A type the
 * repository wrote itself under a borrowed name (`type Partial<T> = ...`)
 * never matches: its declarations are the repository's own, not the
 * language's declaration files. A name the program typechecked with always
 * resolves to its symbol. */
const builtInNamed =
  (names: ReadonlySet<string>): TypeQuestion =>
  (checker) =>
  (node) => {
    if (
      !ts.isTypeReferenceNode(node) ||
      !ts.isIdentifier(node.typeName) ||
      !names.has(node.typeName.text)
    ) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node.typeName) as ts.Symbol;
    // A resolved built-in always carries the language's own declarations.
    const declarations = symbol.declarations as readonly ts.Declaration[];
    return declarations.every(declaredByTheLanguage);
  };

/** The generics a reader reaches one member at a time. `Array<Row>` and
 * `Row[]` are one type written two ways, and `Record<string, Row>` is the
 * index signature written as a generic, which already takes this step. A set
 * holds many the same way, so a field of the shape and a field of what it
 * holds stay two fields. A map is not here: its two arguments are below.
 * These are all exported for the walk, which keeps a generic's argument out
 * unless the generic hands it on unchanged. A `Record` keyed by fixed names
 * rather than a key domain stays out too. Its members are named and reached as
 * `record.fixed`, so the checker reports them like any other named member. */
const ELEMENT_CONTAINERS = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Set",
  "ReadonlySet",
]);

/** The fixed names a `Record` key gives, or no list for an open key domain. */
const fixedKeysOf = (node: ts.TypeNode): FieldName[] | undefined => {
  if (ts.isParenthesizedTypeNode(node)) return fixedKeysOf(node.type);
  if (node.kind === ts.SyntaxKind.NeverKeyword) return [];
  if (!ts.isUnionTypeNode(node)) {
    return ts.isLiteralTypeNode(node) && isFieldName(node.literal)
      ? [node.literal]
      : undefined;
  }
  const parts = node.types.map(fixedKeysOf);
  return parts.every((part): part is FieldName[] => part !== undefined)
    ? parts.flat()
    : undefined;
};

/** The generics a reader reaches one member at a time, except a `Record`
 * keyed by fixed names. Each key names one member, reached as `record.fixed`,
 * so the element step does not apply. */
export const holdsElements =
  (checker: ts.TypeChecker): ((node: ts.Node) => boolean) =>
  (node) => {
    if (!anElementContainer(checker)(node)) return false;
    if (!aRecord(checker)(node)) return true;
    const reference = node as ts.TypeReferenceNode;
    // An element container always writes its arguments down — the name
    // does not typecheck without them.
    const [first] = reference.typeArguments as unknown as [ts.TypeNode];
    return fixedKeysOf(first) === undefined;
  };

const anElementContainer = builtInNamed(ELEMENT_CONTAINERS);

const aRecord = builtInNamed(new Set(["Record"]));

export interface FixedMember {
  name: FieldName;
  symbol: ts.Symbol;
  value: ts.TypeNode;
}

interface FixedParts {
  keys: ts.TypeNode;
  value: ts.TypeNode;
}

/** The two nodes that declare a direct fixed mapping. A remapped type keeps
 * the index path because its source keys do not name its output members. */
const fixedPartsOf = (
  checker: ts.TypeChecker,
  node: ts.Node,
): FixedParts | undefined => {
  if (aRecord(checker)(node)) {
    const reference = node as ts.TypeReferenceNode;
    const [keys, value] = reference.typeArguments as unknown as [
      ts.TypeNode,
      ts.TypeNode,
    ];
    return { keys, value };
  }
  if (!ts.isMappedTypeNode(node) || node.nameType) return;
  const keys = node.typeParameter.constraint;
  const value = node.type;
  return keys && value ? { keys, value } : undefined;
};

/** The named members a direct fixed mapping writes down in its key node. */
export const fixedMembers =
  (checker: ts.TypeChecker): ((node: ts.Node) => FixedMember[] | undefined) =>
  (node) => {
    const parts = fixedPartsOf(checker, node);
    if (!parts) return;
    const { keys, value } = parts;
    const names = fixedKeysOf(keys);
    if (!names) return;
    const type = checker.getTypeAtLocation(node);
    return names.map((name) => ({
      name,
      symbol: answered(
        checker.getPropertyOfType(type, fieldNameText(name)),
        `property ${fieldNameText(name)} of a fixed mapping`,
      ),
      value,
    }));
  };

/** The generics that hold two different kinds of thing at once. The key and
 * the value of a map are reached by two different calls, so a field of each
 * with one name stays two fields. Exported for the walk, which keeps a
 * generic's argument out unless the generic hands it on unchanged. */
export const holdsKeysAndValues: TypeQuestion = builtInNamed(
  new Set(["Map", "ReadonlyMap"]),
);

/** A pass-through generic hands its argument's members on unchanged.
 * `Partial<T>`, `Required<T>` and `Readonly<T>` keep every member of T, with
 * no step between. */
export const passesMembersThrough: TypeQuestion = builtInNamed(
  new Set(["Partial", "Required", "Readonly"]),
);

/** A built-in asynchronous value whose fulfilled value a reader receives. */
export const holdsAnAsyncResult: TypeQuestion = builtInNamed(
  new Set(["Promise", "PromiseLike"]),
);

/** One step down to a field. A `name` is what a field is called, and a `way`
 * is how a reader reaches through a member with no name of its own. The two
 * are kept apart, because a field can be called `"()"` and a call is not one. */
export type Step = { name: string } | { way: string };

export type PathChange = (path: readonly Step[]) => readonly Step[];

export type PathFromNode<Result> = (
  path: readonly Step[],
  node: ts.Node,
) => Result;

export const throughWay =
  (way: string): PathChange =>
  (path) => [...path, { way }];

export const stepText = (step: Step): string =>
  "name" in step ? step.name : step.way;

/** One element of something that holds many. A list and a `Record` read
 * this way, and a shape is never both at one place in the path. */
const ELEMENT = "[]";

/** How a reader reaches through a member that has no name to give. An arrow
 * or a function expression written as a value takes the call step too, so
 * `run = (input) => x` and `run(input) { return x }` name the input the same
 * way. */
const REACHED_THROUGH: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.CallSignature, "()"],
  [ts.SyntaxKind.ConstructSignature, "new ()"],
  [ts.SyntaxKind.FunctionType, "()"],
  [ts.SyntaxKind.ConstructorType, "new ()"],
  [ts.SyntaxKind.ArrowFunction, "()"],
  [ts.SyntaxKind.FunctionExpression, "()"],
  [ts.SyntaxKind.ArrayType, ELEMENT],
  [ts.SyntaxKind.MappedType, ELEMENT],
]);

/** What a constructor's caller supplies an input through. */
const ENTERS_THROUGH = "new ()";

/** The type a call hands back and a caller receives. */
const ITS_RESULT = "result";

/** Put a value under the result a call gives back. Promise wrappers can sit
 * inside a declared return type, so an existing result step stays one step. */
export const throughResult = (path: readonly Step[]): readonly Step[] => {
  const last = path.at(-1);
  return last && "way" in last && last.way === ITS_RESULT
    ? path
    : [...path, { way: ITS_RESULT }];
};

/** The value that a held class creates. The constructor input and its result
 * need both steps so two same-named fields cannot share one identity. */
export const throughConstructedResult = (
  path: readonly Step[],
): readonly Step[] => throughResult([...path, { way: ENTERS_THROUGH }]);

/** The step a caller's input to a constructor takes before its own name. The
 * parameters that arrive at `underAnUnnamedPart` are the inputs a caller
 * supplies — a plain one, or one a word hides — because a public parameter
 * property is a field and never walks. A method's parameter is nobody's
 * input, so only the constructor's take the step. */
const stepThrough = (when: boolean, way: string): readonly { way: string }[] =>
  when ? [{ way }] : [];

/** Whether a parameter arrives through a call the reader writes out. A
 * method's input walks under the call, so it stays apart from the data the
 * method's own name holds. A setter's input arrives through an assignment,
 * which has no call. A constructor's arrives through `new ()`, which is its
 * own step below. */
const arrivesThroughACall = (node: ts.ParameterDeclaration): boolean => {
  const { parent } = node;
  return (
    (parent as { name?: ts.Node }).name !== undefined &&
    !REACHED_THROUGH.has(parent.kind) &&
    !ts.isSetAccessorDeclaration(parent) &&
    !ts.isConstructorDeclaration(parent)
  );
};

/** The step a map's type arguments take apart. The key and the value are
 * reached by two different calls, `keys()` and `values()`, so the first
 * argument is the key's type. A reference that writes no arguments down has
 * none of either, and a map's name does not typecheck without its two. */
const throughTheMap = (
  checker: ts.TypeChecker,
  node: ts.Node,
): { way: string } | undefined => {
  const { parent } = node;
  if (!ts.isTypeReferenceNode(parent)) return;
  const [key] = parent.typeArguments ?? [];
  if (!holdsKeysAndValues(checker)(parent)) return;
  return { way: node === key ? "keys()" : "values()" };
};

/** Whether a type node is the result its parent hands back. A call, a
 * construct, a method, an arrow: the type it returns is what a caller
 * receives, so it takes the `result` step. An index signature's type is not
 * one — it says what every value looks like, so it stays put. An accessor's
 * return is not one either: a getter's value reads as the property's own, so
 * its type walks on the property's path, and a setter writes no return. */
const handsBackItsResult = (node: ts.Node): boolean => {
  const { parent } = node;
  return (
    ts.isTypeNode(node) &&
    ts.isFunctionLike(parent) &&
    !ts.isIndexSignatureDeclaration(parent) &&
    !ts.isAccessor(parent) &&
    parent.type === node
  );
};

/** The step a setter's own name adds, so its input walks under it. A plain
 * word or a quoted one can say where, the way a field's own name does. A
 * name a variable works out cannot, and there is no step. */
const stepOfTheSettersName = (
  name: ts.PropertyName,
): { way: string } | undefined => {
  const written = quotedInBrackets(name) ?? name;
  return isFieldName(written) ? { way: fieldNameText(written) } : undefined;
};

/** The steps a parameter adds before its own name. A method's named
 * parameter is also an input to the method, and it arrives through the call,
 * which is a word of its own. A constructor's caller supplies each input
 * through `new ()`, which is a word of its own too. */
const stepsBeforeTheParametersOwn = (
  node: ts.ParameterDeclaration,
): readonly { way: string }[] => [
  ...stepThrough(ts.isConstructorDeclaration(node.parent), ENTERS_THROUGH),
  ...stepThrough(arrivesThroughACall(node), "()"),
];

/** The step an index signature adds. A shape can hold more than one index
 * signature, each for keys of its own kind, so the kind names the step:
 * `bag[stringKey]` and `bag[symbolKey]` stay two fields. An index signature
 * always writes its one annotated key parameter down — the syntax has no
 * other form. */
const stepOfTheIndexSignature = (
  node: ts.IndexSignatureDeclaration,
): { way: string } => {
  const key = node.parameters[0] as Required<ts.ParameterDeclaration>;
  return { way: `[${key.type.getText()}]` };
};

/** The step a tuple element takes: its place, the way a destructured
 * parameter takes its place in the list. */
const stepOfTheTuplePlace = (
  node: ts.Node,
  tuple: ts.TupleTypeNode,
): { way: string } => {
  const place = tuple.elements as readonly ts.Node[];
  return { way: String(place.indexOf(node)) };
};

/** The final fallthrough step: a list's `[]`, or the way a reader reaches
 * through a member with a spelling in the table. */
const fallThroughText = (
  checker: ts.TypeChecker,
  node: ts.Node,
): string | undefined => {
  if (handsBackItsResult(node)) return ITS_RESULT;
  if (fixedMembers(checker)(node) !== undefined) return;
  return holdsElements(checker)(node)
    ? ELEMENT
    : REACHED_THROUGH.get(node.kind);
};

/** The steps a member with no name of its own adds to the path. A shape can
 * hold more than one of them, and each can carry a field of the same name, so
 * a step that tells them apart is what keeps the two fields two.
 * `send(first: { id: string }, second: { id: string })` is the plain case: the
 * parameter's own name does it. A destructured parameter has no name, so its
 * place in the list stands in. A call signature, a construct signature and an
 * index signature have neither, so the way a reader reaches through it does.
 * `bag[key].total` is a step away from `bag.total`, and without the step the
 * two are one field. A list is the same case: `rows[0].total` is a step away
 * from `rows.total`, so a list and a `Record` add one too. A tuple's elements
 * are reached one place at a time, so each takes its place the way a
 * destructured parameter does.
 * A setter is a step of its own name, because a setter is nobody's to read
 * but its input is everybody's to supply. */
export const underAnUnnamedPart =
  (checker: ts.TypeChecker): PathFromNode<readonly Step[]> =>
  (path, node) => {
    const written = stepsWrittenOnThePart(node);
    if (written) return [...path, ...written];
    const throughMap = throughTheMap(checker, node);
    if (throughMap) return [...path, throughMap];
    const fallThrough = fallThroughText(checker, node);
    return fallThrough === undefined ? path : throughWay(fallThrough)(path);
  };

const stepsWrittenOnThePart = (node: ts.Node): readonly Step[] | undefined => {
  if (ts.isParameter(node)) return stepsOfAParameter(node);
  if (ts.isSetAccessorDeclaration(node)) {
    const step = stepOfTheSettersName(node.name);
    return step ? [step] : [];
  }
  if (ts.isTupleTypeNode(node.parent)) {
    return [stepOfTheTuplePlace(node, node.parent)];
  }
  if (ts.isIndexSignatureDeclaration(node)) {
    return [stepOfTheIndexSignature(node)];
  }
  return;
};

/** The steps a parameter adds: its own name, and the way its caller supplied
 * it (through `new ()`, through a call, or plainly). */
const stepsOfAParameter = (node: ts.ParameterDeclaration): readonly Step[] => {
  const way = ts.isIdentifier(node.name)
    ? node.name.text
    : String(node.parent.parameters.indexOf(node));
  return [...stepsBeforeTheParametersOwn(node), { way }];
};
