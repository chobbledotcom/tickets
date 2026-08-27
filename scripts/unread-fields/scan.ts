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
): Shape[] => {
  const shapes: Shape[] = [];
  for (const exported of checker.getExportsOfModule(container)) {
    const symbol = standsFor(checker, exported);
    for (const declaration of declaredIn(symbol, file)) {
      if (isShape(declaration)) shapes.push(declaration);
      else if (ts.isModuleDeclaration(declaration)) {
        shapes.push(...exportedShapes(checker, symbol, file));
      }
    }
  }
  return shapes;
};

/** Every field an exported shape declares, including the fields of object
 * types nested inside it, since `shape.inner.total` reaches those too. The
 * owner carries the path down to the field, so the two `dbConfigured` fields
 * of `DebugPageState` do not report as one line. */
const exportedFields = (
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): { owner: string; field: ts.Identifier }[] => {
  const container = checker.getSymbolAtLocation(source);
  if (!container) return [];
  const found: { owner: string; field: ts.Identifier }[] = [];
  const collect = (owner: string, node: ts.Node): void => {
    const name = ts.isTypeElement(node) ? node.name : undefined;
    if (name && ts.isIdentifier(name)) {
      found.push({ field: name, owner });
      const inside = `${owner}.${name.text}`;
      ts.forEachChild(node, (child) => collect(inside, child));
      return;
    }
    ts.forEachChild(node, (child) => collect(owner, child));
  };
  for (const shape of exportedShapes(checker, container, source.fileName)) {
    collect(shape.name.text, shape);
  }
  return found;
};

/** Ask the service who reads one field, and say where those readers live. */
const readersOf = (
  service: ts.LanguageService,
  program: ts.Program,
  root: string,
  file: string,
  field: ts.Identifier,
): string[] => {
  const references = answered(
    service.findReferences(file, field.getStart()),
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
        file: file.replace(`${root}/`, ""),
        owner,
        verdict: verdictFor(readersOf(service, program, root, file, field)),
      });
    }
  }
  return findings;
};
