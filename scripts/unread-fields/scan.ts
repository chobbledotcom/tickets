/**
 * The scan itself: build a TypeScript view of the repository, then ask it
 * who reads each exported field.
 *
 * A text search cannot answer this. `.failed` appears on several unrelated
 * types and inside a translation key, so a name match calls a dead field
 * alive. The type checker knows which symbol each mention belongs to.
 */

import ts from "typescript";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import { aliasPaths } from "./aliases.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, serviceHost } from "./host.ts";
import { isWrite, nodeAt } from "./writes.ts";

/** Folders whose code ships. `test/` is scanned too, so the scan can tell a
 * field only its tests read from one nothing reads. */
const SCANNED = ["src", "test", "scripts", "cli"];

const sourceFilesIn = async (root: string): Promise<string[]> => {
  const perFolder = await Promise.all(
    SCANNED.map((folder) => collectSourceFiles(`${root}/${folder}`)),
  );
  return perFolder.flat();
};

type Shape = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

const isShape = (node: ts.Node): node is Shape =>
  ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);

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

/** Every shape a file lets other files reach. Asking the checker, rather than
 * reading `export` off the declaration, also catches the seven aliases of
 * `settings-helpers.ts`, which are declared plainly and exported in a list at
 * the foot of the file. A namespace is a module too, so it is asked in turn. */
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
  ts.isInterfaceDeclaration(shape) ? shape.members : [shape.type];

/** The identifier a type element is named by. An index signature has no name,
 * and a quoted member is not named by an identifier, so neither is a field the
 * scan can look up. */
const fieldNameOf = (node: ts.Node): ts.Identifier | undefined => {
  const name = ts.isTypeElement(node) ? node.name : undefined;
  return name && ts.isIdentifier(name) ? name : undefined;
};

/** Whether a shape takes fields from somewhere else: an interface that
 * extends, or an alias that intersects. A union alias is left out, because its
 * common fields belong to the shapes it is made of. */
const inheritsFrom = (shape: Shape): boolean =>
  ts.isInterfaceDeclaration(shape)
    ? shape.heritageClauses !== undefined
    : ts.isIntersectionTypeNode(shape.type);

/** The fields an exported shape gets from somewhere else.
 * `UntaggedPaymentReference` takes `reference` from a base its own file keeps
 * to itself, and `CheckoutIntent` intersects one. A reader of either reaches
 * those fields like any other. A field the shape declares again is already
 * counted. */
const inheritedFields = (
  checker: ts.TypeChecker,
  shape: Shape,
  own: Set<ts.Identifier>,
): OwnedField[] => {
  if (!inheritsFrom(shape)) return [];
  const found: OwnedField[] = [];
  const type = checker.getTypeAtLocation(shape.name);
  for (const property of checker.getPropertiesOfType(type)) {
    for (const declaration of answered(
      property.declarations,
      `declarations for ${property.name}`,
    )) {
      const name = fieldNameOf(declaration);
      if (name && !own.has(name)) {
        found.push({ field: name, owner: shape.name.text });
      }
    }
  }
  return found;
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
  const collect = (owner: string, node: ts.Node): void => {
    const name = fieldNameOf(node);
    if (name) {
      found.push({ field: name, owner });
      const inside = `${owner}.${name.text}`;
      ts.forEachChild(node, (child) => collect(inside, child));
      return;
    }
    ts.forEachChild(node, (child) => collect(owner, child));
  };
  for (const shape of exportedShapes(checker, container, source.fileName)) {
    const before = found.length;
    for (const part of shapeBody(shape)) collect(shape.name.text, part);
    const own = new Set(found.slice(before).map((f) => f.field));
    found.push(...inheritedFields(checker, shape, own));
  }
  return found;
};

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
  const readers: string[] = [];
  for (const group of references) {
    for (const reference of group.references) {
      if (reference.isDefinition) continue;
      const source = program.getSourceFile(reference.fileName);
      const node = source && nodeAt(source, reference.textSpan.start);
      if (!node || isWrite(node)) continue;
      readers.push(reference.fileName.replace(`${root}/`, ""));
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
