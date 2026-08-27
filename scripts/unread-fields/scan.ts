/**
 * The scan itself: build a TypeScript view of the repository, then ask it
 * who reads each exported field.
 *
 * A text search cannot answer this. `.failed` appears on several unrelated
 * types and inside a translation key, so a name match calls a dead field
 * alive. The type checker knows which symbol each mention belongs to.
 */

import ts from "typescript";
import { filter, mapNotNullish, unique } from "#fp";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import { aliasPaths } from "./aliases.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, pathIs, serviceHost } from "./host.ts";
import {
  type AskAboutAMention,
  isInside,
  namesAMember,
  nodeAt,
  readsTheValue,
} from "./writes.ts";

/** Folders whose code ships. `test/` is scanned too, so the scan can tell a
 * field only its tests read from one nothing reads, and so are the two live
 * end-to-end harnesses, which read production fields the same way. A
 * repository without one of these folders is normal, so the walk skips it. */
const SCANNED = ["src", "test", "scripts", "cli", "e2e-payments/src"];

const isDirectory = pathIs("isDirectory");

const sourceFilesIn = async (root: string): Promise<string[]> => {
  const here = SCANNED.filter((folder) => isDirectory(`${root}/${folder}`));
  const perFolder = await Promise.all(
    here.map((folder) => collectSourceFiles(`${root}/${folder}`)),
  );
  return perFolder.flat();
};

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
 * it stands for before looking at where it was written down. */
const standsFor = (checker: ts.TypeChecker, exported: ts.Symbol): ts.Symbol =>
  (exported.flags & ts.SymbolFlags.Alias) === 0
    ? exported
    : checker.getAliasedSymbol(exported);

/** Where a symbol was written down, keeping this file only, because a
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
  return shapes;
};

/** One field the scan looked at, and the shape it belongs to. A field can be
 * written down in more than one place: both arms of a union declare it, and a
 * read points at whichever arm it holds. The first name says where a reader
 * has to go, and the rest are the other places a read can point at. */
interface OwnedField {
  names: [FieldName, ...FieldName[]];
  owner: string;
}

/** What a shape is made of. Its type parameters stay out. A constraint such
 * as `<E extends { id: number }>` describes E, and `id` is no field of the
 * shape itself. */
const shapeBody = (shape: Shape): readonly ts.Node[] =>
  ts.isTypeAliasDeclaration(shape) ? [shape.type] : shape.members;

/** A member nobody outside the class can reach is not a field it hands out. */
const isHidden = (node: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) &
    (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
  0;

/** A member that holds a field. `SafeHtml` writes its one field as
 * `constructor(public html: string)`, which is a parameter and a field at
 * once. A plain constructor parameter is not one. */
const holdsAField = (node: ts.Node): node is ts.NamedDeclaration =>
  ts.isTypeElement(node) ||
  ts.isPropertyDeclaration(node) ||
  (ts.isParameter(node) &&
    ts.isParameterPropertyDeclaration(node, node.parent));

/** A field's name as it is written down. `row["status-code"]` reaches the
 * same member as `row.total`, so a quoted or numbered name counts. A computed
 * name is worked out when the program runs, and a `#private` one is nobody
 * else's to reach, so neither is a field the scan can look up. */
type FieldName = ts.Identifier | ts.StringLiteral | ts.NumericLiteral;

const isFieldName = (node: ts.Node): node is FieldName =>
  ts.isIdentifier(node) ||
  ts.isStringLiteral(node) ||
  ts.isNumericLiteral(node);

/** The name a declaration is written down by. An index signature has none. */
const nameOf = (node: ts.Node): FieldName | undefined => {
  if (isHidden(node)) return;
  const { name } = node as ts.NamedDeclaration;
  return name && isFieldName(name) ? name : undefined;
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

/** The fields an exported shape gets from somewhere else.
 * `UntaggedPaymentReference` takes `reference` from a base its own file keeps
 * to itself, and `CheckoutIntent` intersects one. A reader of either reaches
 * those fields like any other. A field the shape declares again is already
 * counted. */
type NamesByField = Map<string, [FieldName, ...FieldName[]]>;

/** Remember one more place a field is written down. */
const rememberName = (byField: NamesByField, name: FieldName): void => {
  const found = byField.get(name.text);
  if (found) found.push(name);
  else byField.set(name.text, [name]);
};

const inheritedFields = (
  checker: ts.TypeChecker,
  shape: Shape,
  own: Set<string>,
): OwnedField[] => {
  if (!inheritsFrom(shape)) return [];
  const written = partsOf(checker.getTypeAtLocation(shape.name))
    .flatMap((part) => checker.getPropertiesOfType(part))
    .flatMap(writtenNames)
    .filter((name) => !own.has(name.text));
  // One field deserves one line, because two could disagree. Both arms of a
  // union write the shared field down, and a read points at one arm, so the
  // line carries every arm or it misses the readers of the others.
  const byField: NamesByField = new Map();
  for (const name of written) rememberName(byField, name);
  return [...byField.values()].map((names) => ({
    names,
    owner: shape.name.text,
  }));
};

/** `keyof Row` names the words a shape's fields are called, not the fields. */
const isKeyOf = (node: ts.Node): boolean =>
  ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword;

/** Which of a node's parts can hold a member. `R extends { paid: number } ?
 * { paid: string } : never` checks one type against another, and only the
 * answer is part of the shape. A function keeps its parameters and the type it
 * hands back. Its body holds a type that never leaves it, and its type
 * parameters describe themselves, exactly as a shape's own ones do. */
const worthWalking = (node: ts.Node): ((part: ts.Node) => boolean) => {
  // `keyof { paid: number }` is the one word "paid", not a shape with a
  // field, so nothing under it is a field either. `readonly` is a type
  // operator too, and `readonly { paid: number }[]` does hand `paid` out.
  if (isKeyOf(node)) return () => false;
  if (ts.isConditionalTypeNode(node)) {
    return (part) => part !== node.checkType && part !== node.extendsType;
  }
  if (!ts.isFunctionLike(node)) return () => true;
  return (part) => ts.isTypeNode(part) || ts.isParameter(part);
};

/** The parts of a node the walk goes on through. */
const membersOf = (node: ts.Node): ts.Node[] => {
  const parts: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    parts.push(child);
  });
  return filter(worthWalking(node))(parts);
};

/** Every field an exported shape declares, including the fields of object
 * types nested inside it, since `shape.inner.total` reaches those too. The
 * owner carries the path down to the field, so the two `dbConfigured` fields
 * of `DebugPageState` do not report as one line. */
const exportedFields = (
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): OwnedField[] => {
  const container = checker.getSymbolAtLocation(source);
  if (!container) return [];
  const found: OwnedField[] = [];
  // Both arms of `{ ok: true } | { ok: false }` write `ok` down, and the two
  // are one field of the shape. A second line for it could reach a different
  // verdict, and a reader could not tell which one to act on.
  const counted = new Set<string>();
  /** Write one field down, and say what its own parts belong to. A shape
   * that already carries the line keeps the one it has. */
  const remember = (owner: string, name: FieldName): string => {
    const inside = `${owner}.${name.text}`;
    if (counted.has(inside)) return inside;
    counted.add(inside);
    found.push({ names: [name], owner });
    return inside;
  };

  const collect = (owner: string, node: ts.Node): void => {
    // A member a class keeps to itself hands nothing out. A type written
    // inside it is out of reach for the same reason.
    if (isHidden(node)) return;
    // `Extract<Result, { ok: true }>` names a filter, not a member. The walk
    // must not read `ok` off it, because the checker path already resolves
    // what the reference hands on. Such a reference is no field itself, so
    // this asks nothing about the name below.
    if (ts.isTypeReferenceNode(node)) return;
    const name = fieldNameOf(node);
    const inside = name ? remember(owner, name) : owner;
    for (const child of membersOf(node)) collect(inside, child);
  };
  for (const shape of exportedShapes(checker, container, source.fileName)) {
    const before = found.length;
    for (const part of shapeBody(shape)) collect(shape.name.text, part);
    // Only what the shape writes down itself. A field of an object type nested
    // inside it is a different field with the same name, and counting it here
    // would hide the one the shape takes from somewhere else.
    const own = new Set(
      found
        .slice(before)
        .filter((found) => found.owner === shape.name.text)
        .map((found) => found.names[0].text),
    );
    found.push(...inheritedFields(checker, shape, own));
  }
  return found;
};

/** Whether one reference takes the field's value out. */
const readsHere = (
  program: ts.Program,
  reference: ts.ReferencedSymbolEntry,
  namesTheNamesake: AskAboutAMention,
): boolean => {
  if (reference.isDefinition) return false;
  const source = program.getSourceFile(reference.fileName);
  const node = source && nodeAt(source, reference.textSpan.start);
  if (!node || !readsTheValue(node)) return false;
  return !namesTheNamesake(node);
};

/** Two ways of writing a field give it a namesake the compiler cannot tell it
 * apart from. `constructor(public value: string)` declares a parameter beside
 * the field, and the parameter is only there inside the constructor.
 * `{ value }` declares the field out of a local, and that local is there for
 * the whole file. This says where the namesake lives, or nothing when the
 * field has none. */
const livesBesideANamesake = (field: FieldName): ts.Node | undefined => {
  const holder = field.parent;
  if (ts.isParameterPropertyDeclaration(holder, holder.parent)) {
    return holder.parent;
  }
  return ts.isShorthandPropertyAssignment(holder)
    ? field.getSourceFile()
    : undefined;
};

/** Where a field has a namesake, a plain mention of the name is the namesake
 * and no value leaves the field. `this.value` and `const { value } = held`
 * name the field, and so does every mention outside the namesake's reach. */
const namesTheNamesakeOf = (field: FieldName): AskAboutAMention => {
  const namesake = livesBesideANamesake(field);
  if (!namesake) return () => false;
  const withinReach = isInside(namesake);
  return (node) => withinReach(node) && !namesAMember(node);
};

/** Ask the service who reads one written-down name, and say where those
 * readers live. An inherited field was written down in the base's file, not in
 * the shape's, so the lookup starts from the file that declares it. */
const readersOfName = (
  service: ts.LanguageService,
  program: ts.Program,
  root: string,
  field: FieldName,
): string[] => {
  const references = answered(
    service.findReferences(field.getSourceFile().fileName, field.getStart()),
    `references for ${field.text}`,
  );
  const namesTheNamesake = namesTheNamesakeOf(field);
  const readers: string[] = [];
  for (const group of references) {
    for (const reference of group.references) {
      if (readsHere(program, reference, namesTheNamesake)) {
        readers.push(reference.fileName.replace(`${root}/`, ""));
      }
    }
  }
  return readers;
};

/** Everyone who reads a field, wherever it was written down. */
const readersOf = (
  service: ts.LanguageService,
  program: ts.Program,
  root: string,
  names: readonly FieldName[],
): string[] =>
  unique(names.flatMap((name) => readersOfName(service, program, root, name)));

/** Look at every exported field the repository declares under `src/`. */
export const scanUnreadFields = async (root: string): Promise<Finding[]> => {
  const config = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
  const files = await sourceFilesIn(root);
  const options = compilerOptions(root, aliasPaths(config.imports));
  const service = ts.createLanguageService(
    serviceHost(root, files, options),
    ts.createDocumentRegistry(),
  );
  const program = answered(service.getProgram(), "program for the scan");
  const checker = program.getTypeChecker();

  // The program also holds every locale JSON that `src/` imports, and every
  // file it reached outside `src/`. Only the TypeScript the walk found counts.
  const scanned = new Set(files.filter((f) => f.startsWith(`${root}/src/`)));
  const findings: Finding[] = [];
  for (const source of program.getSourceFiles()) {
    const file = source.fileName;
    if (!scanned.has(file)) continue;
    for (const { owner, names } of exportedFields(checker, source)) {
      findings.push({
        field: names[0].text,
        // Where a reader has to go to find it, which is where it was written
        // down rather than the shape that hands it on.
        file: names[0].getSourceFile().fileName.replace(`${root}/`, ""),
        owner,
        verdict: verdictFor(readersOf(service, program, root, names)),
      });
    }
  }
  return findings;
};
