/**
 * The scan itself: build a TypeScript view of the repository, then ask it
 * who reads each exported field.
 *
 * A text search cannot answer this. `.failed` appears on several unrelated
 * types and inside a translation key, so a name match calls a dead field
 * alive. The type checker knows which symbol each mention belongs to.
 */

import ts from "typescript";
import { mapNotNullish } from "#fp";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import { aliasPaths } from "./aliases.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, serviceHost } from "./host.ts";
import { namesAMember, nodeAt, readsTheValue } from "./writes.ts";

/** Folders whose code ships. `test/` is scanned too, so the scan can tell a
 * field only its tests read from one nothing reads. */
const SCANNED = ["src", "test", "scripts", "cli"];

const sourceFilesIn = async (root: string): Promise<string[]> => {
  const perFolder = await Promise.all(
    SCANNED.map((folder) => collectSourceFiles(`${root}/${folder}`)),
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

/** One field the scan looked at, and the shape it belongs to. */
interface OwnedField {
  field: ts.Identifier;
  owner: string;
}

/** What a shape is made of, leaving out its type parameters: a constraint like
 * `<E extends { id: number }>` describes E, and `id` is not a field of the
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

/** The identifier a declaration is named by. An index signature has no name,
 * and a quoted or `#private` member is not named by an identifier, so neither
 * is a field the scan can look up. */
const nameOf = (node: ts.Node): ts.Identifier | undefined => {
  if (isHidden(node)) return;
  const { name } = node as ts.NamedDeclaration;
  return name && ts.isIdentifier(name) ? name : undefined;
};

/** The same question asked of a shape's own syntax, where a node has to be a
 * member before its name is a field. The checker needs no such guard, because
 * it hands back properties and nothing else. */
const fieldNameOf = (node: ts.Node): ts.Identifier | undefined =>
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

/** Where one borrowed field is written down, or nothing when the shape names
 * it itself. A field can be written down more than once — `PaymentFailureResult`
 * gets `success` from its own arm and from `PaymentFailure` — and one field
 * deserves one line, because two could disagree. */
const borrowedName = (
  property: ts.Symbol,
  own: Set<string>,
): ts.Identifier | undefined => {
  // A mapped type such as `Partial<Listing>` makes up its properties, so some
  // are written down nowhere and the scan has no identifier to look up. A
  // library's own members are written down, but not by this repository:
  // `Config["total"]` resolves to `number`, which carries `toFixed`.
  const written = (property.declarations ?? []).filter(
    (at) => !at.getSourceFile().isDeclarationFile,
  );
  const names = mapNotNullish(nameOf)(written);
  return names.some((name) => own.has(name.text)) ? undefined : names[0];
};

/** The fields an exported shape gets from somewhere else.
 * `UntaggedPaymentReference` takes `reference` from a base its own file keeps
 * to itself, and `CheckoutIntent` intersects one. A reader of either reaches
 * those fields like any other. A field the shape declares again is already
 * counted. */
const inheritedFields = (
  checker: ts.TypeChecker,
  shape: Shape,
  own: Set<string>,
): OwnedField[] => {
  if (!inheritsFrom(shape)) return [];
  const found: OwnedField[] = [];
  const type = checker.getTypeAtLocation(shape.name);
  for (const part of partsOf(type)) {
    for (const property of checker.getPropertiesOfType(part)) {
      const field = borrowedName(property, own);
      if (field) {
        own.add(field.text);
        found.push({ field, owner: shape.name.text });
      }
    }
  }
  return found;
};

/** The parts of a node that can hold a member. `R extends { paid: number } ?
 * { paid: string } : never` checks one type against another, and only the
 * answer is part of the shape. */
const membersOf = (node: ts.Node): ts.Node[] => {
  const parts: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    parts.push(child);
  });
  if (!ts.isConditionalTypeNode(node)) return parts;
  return parts.filter(
    (part) => part !== node.checkType && part !== node.extendsType,
  );
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
  const collect = (owner: string, node: ts.Node): void => {
    const name = fieldNameOf(node);
    if (name) {
      const inside = `${owner}.${name.text}`;
      if (!counted.has(inside)) {
        counted.add(inside);
        found.push({ field: name, owner });
      }
      ts.forEachChild(node, (child) => collect(inside, child));
      return;
    }
    // `Extract<Result, { ok: true }>` names a filter, not a member. The walk
    // must not read `ok` off it, because the checker path already resolves
    // what the reference hands on.
    if (!ts.isTypeReferenceNode(node)) {
      for (const child of membersOf(node)) collect(owner, child);
    }
  };
  for (const shape of exportedShapes(checker, container, source.fileName)) {
    const before = found.length;
    for (const part of shapeBody(shape)) collect(shape.name.text, part);
    const own = new Set(found.slice(before).map((f) => f.field.text));
    found.push(...inheritedFields(checker, shape, own));
  }
  return found;
};

/** Whether one reference takes the field's value out. */
const readsHere = (
  program: ts.Program,
  reference: ts.ReferencedSymbolEntry,
  onlyThroughAMember: boolean,
): boolean => {
  if (reference.isDefinition) return false;
  const source = program.getSourceFile(reference.fileName);
  const node = source && nodeAt(source, reference.textSpan.start);
  if (!node || !readsTheValue(node)) return false;
  return !onlyThroughAMember || namesAMember(node);
};

/** Whether a field is written down as a constructor parameter. The answer
 * already requires a constructor above it, so it needs no second question. */
const isParameterProperty = (field: ts.Identifier): boolean =>
  ts.isParameterPropertyDeclaration(field.parent, field.parent.parent);

/** Ask the service who reads one field, and say where those readers live. A
 * position means nothing without the file it counts from, and an inherited
 * field was written down in the base's file, not in the shape's. */
const readersOf = (
  service: ts.LanguageService,
  program: ts.Program,
  root: string,
  field: ts.Identifier,
): string[] => {
  const references = answered(
    service.findReferences(field.getSourceFile().fileName, field.getStart()),
    `references for ${field.text}`,
  );
  // `constructor(public value: string)` declares a parameter and a field with
  // one name, and the compiler answers a lookup with both. `super(value)` in
  // that constructor names the parameter, and no value leaves the field.
  const onlyThroughAMember = isParameterProperty(field);
  const readers: string[] = [];
  for (const group of references) {
    for (const reference of group.references) {
      if (readsHere(program, reference, onlyThroughAMember)) {
        readers.push(reference.fileName.replace(`${root}/`, ""));
      }
    }
  }
  return readers;
};

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
    for (const { owner, field } of exportedFields(checker, source)) {
      findings.push({
        field: field.text,
        // Where a reader has to go to find it, which is where it was written
        // down rather than the shape that hands it on.
        file: field.getSourceFile().fileName.replace(`${root}/`, ""),
        owner,
        verdict: verdictFor(readersOf(service, program, root, field)),
      });
    }
  }
  return findings;
};
