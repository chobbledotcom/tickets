/**
 * Who reads each reported field. One walk over the program answers for every
 * field at once; a search per field walks the whole program once per field
 * and takes minutes.
 *
 * A mention names a field when the compiler answers both with the same
 * declaration. Two ties need help: an instantiated generic hands its members
 * a fresh symbol whose declarations still point at the original, and a class
 * member ties to the interface member it implements, in both directions.
 */

import ts from "typescript";
import {
  type FieldName,
  fieldNameText,
  isNegativeNumericName,
} from "./fields/names.ts";
import type { OwnedField } from "./fields.ts";
import { answered } from "./host.ts";
import { namesAMember, readsTheValue } from "./writes.ts";

/** The symbols a field's name stands for beyond its own. */
type SymbolsOfAName = (
  checker: ts.TypeChecker,
  name: FieldName,
) => readonly ts.Symbol[];

/** The type that holds one negative member mention. */
const typeAtNegativeMember = (
  checker: ts.TypeChecker,
  node: ts.PrefixUnaryExpression,
): ts.Type => {
  const { parent } = node;
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node
  ) {
    return checker.getTypeAtLocation(parent.expression);
  }
  const computed = answered(
    ts.findAncestor(node, ts.isComputedPropertyName),
    `computed name at ${node.getStart()}`,
  );
  const member = computed.parent;
  if (ts.isBindingElement(member)) {
    return checker.getTypeAtLocation(member.parent);
  }
  const pattern = answered(
    ts.findAncestor(computed, ts.isObjectLiteralExpression),
    `assignment pattern at ${node.getStart()}`,
  );
  return checker.getTypeOfAssignmentPattern(pattern);
};

/** The type one binding pattern draws its members out of, where the compiler
 * ties a shorthand binding to the field it reads. The compiler applies the
 * annotation, the initializer, the context a parameter carries, and the
 * element a for-of loop hands it — including a set or a generator, whose
 * element type no number index answers. */
const typeADrawingBindsFrom = (
  checker: ts.TypeChecker,
  pattern: ts.ObjectBindingPattern,
): ts.Type | undefined => checker.getTypeAtLocation(pattern);

/** Whether one object literal takes values in through a destructuring
 * assignment, however deeply it nests: `({ a: { b: out } } = held)`,
 * `for ({ a: out } of rows)`, and the parenthesized `(({ a: out }) = held)`. */
const takesValuesIn = (pattern: ts.ObjectLiteralExpression): boolean => {
  const { parent } = pattern;
  if (ts.isPropertyAssignment(parent)) return takesValuesIn(parent.parent);
  if (ts.isParenthesizedExpression(parent)) {
    return (
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.parent.left === parent
    );
  }
  return (
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === pattern) ||
    (ts.isForOfStatement(parent) && parent.initializer === pattern)
  );
};

/** The type a shorthand mention draws its value from, when the mention is
 * the shorthand. Nothing otherwise. A rest binding names no member — the
 * local it declares gathers what is left, so the name answers no field. */
const drawnFrom = (
  checker: ts.TypeChecker,
  node: ts.Identifier,
  parent: ts.Node,
): ts.Type | undefined => {
  if (
    ts.isBindingElement(parent) &&
    parent.name === node &&
    !parent.dotDotDotToken
  ) {
    const pattern = parent.parent;
    return ts.isObjectBindingPattern(pattern)
      ? typeADrawingBindsFrom(checker, pattern)
      : undefined;
  }
  const namesAnAssignedSlot =
    (ts.isShorthandPropertyAssignment(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name === node &&
    ts.isObjectLiteralExpression(parent.parent) &&
    takesValuesIn(parent.parent);
  if (namesAnAssignedSlot) {
    const pattern = parent.parent;
    // Parentheses hide the target from the compiler's per-pattern
    // question, so the assignment's right side answers there.
    if (ts.isParenthesizedExpression(pattern.parent)) {
      const assignment = pattern.parent.parent as ts.BinaryExpression;
      return checker.getTypeAtLocation(assignment.right);
    }
    // The compiler works the type out per pattern: the key of a nested
    // pattern draws from the type that pattern takes in, not from the
    // whole assignment's source.
    return checker.getTypeOfAssignmentPattern(pattern);
  }
  return;
};

/** The property symbols one member mention reaches. A shorthand binding
 * (`const { total } = row`) resolves through the type it binds from; the
 * plain symbol of the binding answers with the local it declares. */
const symbolsAtMention = (
  checker: ts.TypeChecker,
  node: ts.Node,
): readonly ts.Symbol[] => {
  const { parent } = node;
  if (ts.isIdentifier(node)) {
    const drawn = drawnFrom(checker, node, parent);
    const bound = drawn && checker.getPropertyOfType(drawn, node.text);
    if (bound) return checker.getRootSymbols(bound);
  }
  const direct = checker.getSymbolAtLocation(node);
  if (direct) return checker.getRootSymbols(direct);
  if (!isNegativeNumericName(node)) return [];
  const property = checker.getPropertyOfType(
    checker.getNonNullableType(typeAtNegativeMember(checker, node)),
    fieldNameText(node),
  );
  // An open number index accepts this mention without a fixed property.
  return property ? checker.getRootSymbols(property) : [];
};

/** The class or interface one member is declared in, for each declaration it
 * has. Members of other kinds answer nothing to climb through. */
const ownersOfSymbol = (
  symbol: ts.Symbol,
): readonly (ts.ClassLikeDeclaration | ts.InterfaceDeclaration)[] => {
  const holders: (ts.ClassLikeDeclaration | ts.InterfaceDeclaration)[] = [];
  for (const declaration of symbol.declarations ?? []) {
    const holder = declaration.parent;
    if (ts.isClassLike(holder) || ts.isInterfaceDeclaration(holder)) {
      holders.push(holder);
    }
  }
  return holders;
};

/** The same-named members every super type of the holder declares, through
 * the heritage clauses the holder writes down. */
const sameNamedSymbolsInSuperTypes = (
  checker: ts.TypeChecker,
  holder: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
  symbol: ts.Symbol,
): readonly ts.Symbol[] => {
  const found: ts.Symbol[] = [];
  for (const clause of holder.heritageClauses ?? []) {
    for (const type of clause.types) {
      const property = checker.getPropertyOfType(
        checker.getTypeAtLocation(type),
        symbol.name,
      );
      if (!property) continue;
      found.push(...checker.getRootSymbols(property));
    }
  }
  return found;
};

/** The same-named symbols one member ties to through the heritage of the
 * class or interface that owns it: the member a class implements of an
 * interface, and the member a subclass carries of its base. When only the
 * classes count, an interface that redeclares a member it extends ties no
 * read to the redeclaration: the read of the base member never asked the
 * narrowed one. */
const heritageSymbolsThrough = (
  checker: ts.TypeChecker,
  classesOnly: boolean,
) => {
  const closureByRoot = new Map<ts.Symbol, readonly ts.Symbol[]>();
  const climb = (
    symbol: ts.Symbol,
    seen: Set<ts.Symbol>,
    found: ts.Symbol[],
  ): void => {
    for (const holder of climbingHolders(symbol, classesOnly)) {
      for (const base of sameNamedSymbolsInSuperTypes(
        checker,
        holder,
        symbol,
      )) {
        if (base === symbol || seen.has(base)) continue;
        seen.add(base);
        found.push(base);
        climb(base, seen, found);
      }
    }
  };
  return (root: ts.Symbol): readonly ts.Symbol[] => {
    const cached = closureByRoot.get(root);
    if (cached) return cached;
    const seen = new Set<ts.Symbol>([root]);
    const found: ts.Symbol[] = [];
    climb(root, seen, found);
    closureByRoot.set(root, found);
    return found;
  };
};

/** The holders one member's heritage climbs through: every class or
 * interface when all count, only the classes when they alone do. */
const climbingHolders = (symbol: ts.Symbol, classesOnly: boolean) => {
  const holders = ownersOfSymbol(symbol);
  if (!classesOnly) {
    return holders;
  }
  return holders.filter(ts.isClassLike);
};

const heritageSymbols = (checker: ts.TypeChecker) =>
  heritageSymbolsThrough(checker, false);

const classHeritageSymbols = (checker: ts.TypeChecker) =>
  heritageSymbolsThrough(checker, true);

/** The symbols the class property a constructor parameter stands beside
 * answers for. The parameter is only one of them: a `this.` mention reaches
 * the property, so both symbols answer for the field. */
const parameterPropertySymbols: SymbolsOfAName = (checker, name) => {
  const holder = name.parent;
  if (!ts.isParameterPropertyDeclaration(holder, holder.parent)) return [];
  return checker.getSymbolsOfParameterPropertyDeclaration(
    holder,
    fieldNameText(name),
  );
};

/** The same-named members of every arm of the union the field is written
 * in. A reader the compiler narrows to one arm still reads the field the
 * alias reports. */
const unionArmSymbols: SymbolsOfAName = (checker, name) => {
  const alias = enclosingUnionAlias(name);
  if (!alias || !ts.isIdentifier(name)) return [];
  const union = checker.getTypeAtLocation(alias);
  if (!union.isUnion()) return [];
  return union.types.flatMap(
    (arm) => checker.getPropertyOfType(arm, name.text) ?? [],
  );
};

/** The union alias one member is written inside, when the member's own
 * shape is an arm of it: `type R = A | { kind: "withheld" }`. A member of a
 * shape nested deeper answers to its own holder, not to the alias. */
const enclosingUnionAlias = (
  name: ts.Node,
): ts.TypeAliasDeclaration | undefined => {
  const shape = name.parent?.parent;
  if (!shape || !ts.isTypeLiteralNode(shape)) return;
  const holder = shape.parent;
  if (!ts.isUnionTypeNode(holder)) return;
  const alias = holder.parent;
  return ts.isTypeAliasDeclaration(alias) ? alias : undefined;
};

/** Every symbol one field's own declarations stand for: the symbol of each
 * name, the class property a constructor parameter stands beside, the
 * members the checker created, and the members the field's own union arms
 * write down. */
const symbolsDeclaredFor = (
  checker: ts.TypeChecker,
  field: OwnedField,
): readonly ts.Symbol[] => {
  const symbols = new Set<ts.Symbol>();
  const add = (symbol: ts.Symbol | undefined): void => {
    if (!symbol) return;
    for (const root of checker.getRootSymbols(symbol)) symbols.add(root);
  };
  for (const name of field.names) {
    add(checker.getSymbolAtLocation(name));
    for (const symbol of parameterPropertySymbols(checker, name)) add(symbol);
    for (const symbol of unionArmSymbols(checker, name)) add(symbol);
  }
  for (const symbol of field.symbols) add(symbol);
  return [...symbols];
};

/** Where every field answers: by the symbol its declaration stands for,
 * by each declaration of that symbol, and by the members a field ties to
 * through heritage — the read of an interface member also answers for the
 * class field that implements it. */
type FieldOwners = {
  readonly heritageOwners: ReadonlyMap<ts.Symbol, readonly OwnedField[]>;
  readonly ownersOfSymbol: ReadonlyMap<ts.Symbol, readonly OwnedField[]>;
  readonly ownersOfDeclaration: ReadonlyMap<
    ts.Declaration,
    readonly OwnedField[]
  >;
};

/** Everything the one walk needs to answer for the fields. */
type ReaderDeps = HeritageAsk &
  FieldOwners & {
    readonly root: string;
  };

/** What one field question asks with: the checker, and the heritage walk
 * that climbs from a member to the members it ties to. */
type HeritageAsk = {
  readonly checker: ts.TypeChecker;
  readonly heritageOf: (root: ts.Symbol) => readonly ts.Symbol[];
};

/** The fields one symbol answers for, out of the three indexes. */
const fieldsOfSymbol = (
  symbol: ts.Symbol,
  owners: FieldOwners,
): readonly OwnedField[] => [
  ...(owners.ownersOfSymbol.get(symbol) ?? []),
  ...(owners.heritageOwners.get(symbol) ?? []),
  ...(symbol.declarations ?? []).flatMap(
    (declaration) => owners.ownersOfDeclaration.get(declaration) ?? [],
  ),
];

/** The fields one read mention names: the fields its symbols answer for,
 * and the fields the members those tie to through heritage answer for. */
const fieldsOfReadMention = (
  asks: ReaderDeps,
  node: ts.Node,
): readonly OwnedField[] => {
  const fields: OwnedField[] = [];
  for (const symbol of symbolsAtMention(asks.checker, node)) {
    for (const rootSymbol of [symbol, ...asks.heritageOf(symbol)]) {
      fields.push(...fieldsOfSymbol(rootSymbol, asks));
    }
  }
  return fields;
};

const collectReadersIn =
  (deps: ReaderDeps) =>
  (
    source: ts.SourceFile,
    readersOfField: Map<OwnedField, Set<string>>,
  ): void => {
    const file = source.fileName.replace(`${deps.root}/`, "");
    const read = (node: ts.Node): void => {
      if (namesAMember(node) && readsTheValue(node)) {
        for (const field of fieldsOfReadMention(deps, node)) {
          readersOfField.get(field)?.add(file);
        }
      }
      ts.forEachChild(node, read);
    };
    read(source);
  };

/** Index the fields by the symbols their declarations stand for, by each
 * declaration of those symbols, and by the members a field's heritage ties
 * it to. */
const indexFieldOwners = (
  asks: HeritageAsk,
  fields: readonly OwnedField[],
): FieldOwners => {
  const heritageOwners = new Map<ts.Symbol, OwnedField[]>();
  const ownersOfSymbol = new Map<ts.Symbol, OwnedField[]>();
  const ownersOfDeclaration = new Map<ts.Declaration, OwnedField[]>();
  for (const field of fields) {
    for (const symbol of symbolsDeclaredFor(asks.checker, field)) {
      addOwner(ownersOfSymbol, symbol, field);
      for (const member of asks.heritageOf(symbol)) {
        addOwner(heritageOwners, member, field);
      }
      for (const declaration of symbol.declarations ?? []) {
        addOwner(ownersOfDeclaration, declaration, field);
      }
    }
  }
  return { heritageOwners, ownersOfDeclaration, ownersOfSymbol };
};

const addOwner = <K>(
  owners: Map<K, OwnedField[]>,
  key: K,
  field: OwnedField,
): void => {
  const known = owners.get(key);
  if (known) {
    known.push(field);
  } else {
    owners.set(key, [field]);
  }
};

/** Everyone who reads the fields, in one walk over every non-declaration
 * file the program holds. Each member mention that takes a value out names
 * the field its symbol belongs to. */
export const readersOfFields =
  (deps: {
    readonly checker: ts.TypeChecker;
    readonly program: ts.Program;
    readonly root: string;
  }) =>
  (fields: readonly OwnedField[]): Map<OwnedField, readonly string[]> => {
    const heritageOf = heritageSymbols(deps.checker);
    const readersOfField = new Map<OwnedField, Set<string>>();
    for (const field of fields) readersOfField.set(field, new Set());
    const classHeritageOf = classHeritageSymbols(deps.checker);
    const { heritageOwners, ownersOfDeclaration, ownersOfSymbol } =
      indexFieldOwners(
        { checker: deps.checker, heritageOf: classHeritageOf },
        fields,
      );
    for (const source of deps.program.getSourceFiles()) {
      if (source.isDeclarationFile) continue;
      collectReadersIn({
        checker: deps.checker,
        heritageOf,
        heritageOwners,
        ownersOfDeclaration,
        ownersOfSymbol,
        root: deps.root,
      })(source, readersOfField);
    }
    return new Map(
      [...readersOfField].map(([field, files]) => [field, [...files]] as const),
    );
  };
