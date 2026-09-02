/**
 * The scan itself: build a TypeScript view of the repository, then ask it
 * who reads each exported field.
 *
 * A text search cannot answer this. `.failed` appears on several unrelated
 * types and inside a translation key, so a name match calls a dead field
 * alive. The type checker knows which symbol each mention belongs to.
 */

import ts from "typescript";
import { unique } from "#fp";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import { aliasPaths } from "./aliases.ts";
import {
  type FieldName,
  fieldNameText,
  isNegativeNumericName,
} from "./fields/names.ts";
import { exportedFields } from "./fields.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, pathIs, serviceHost } from "./host.ts";
import { ownerPath } from "./identity.ts";
import {
  type AskAboutAMention,
  isInside,
  namesAMember,
  nodeAt,
  readsTheValue,
} from "./writes.ts";

/** The folder the report is about. Without it there is nothing to say, and a
 * run that says every one of no fields is read reads like a clean bill. */
const REPORTED = "src";

/** Other folders that can read reported fields. They include tests, live
 * end-to-end harnesses, and supported CLI and maintenance tools. A repository
 * without one of these folders is normal, so the walk skips it. */
const ALSO_READ = ["test", "scripts", "cli", "e2e-payments/src"];

const isDirectory = pathIs("isDirectory");

const sourceFilesIn = async (root: string): Promise<string[]> => {
  if (!isDirectory(`${root}/${REPORTED}`)) {
    throw new Error(`The repository at ${root} has no ${REPORTED} folder`);
  }
  const here = ALSO_READ.filter((folder) => isDirectory(`${root}/${folder}`));
  const [reported, alsoRead] = await Promise.all([
    collectSourceFiles(`${root}/${REPORTED}`),
    Promise.all(here.map((folder) => collectSourceFiles(`${root}/${folder}`))),
  ]);
  // An empty folder reports nothing, and nothing reads like a clean bill.
  if (reported.length === 0) {
    throw new Error(`The ${REPORTED} folder at ${root} holds no source file`);
  }
  return [reported, ...alsoRead].flat();
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

/** A field gets a namesake the compiler cannot tell it apart from in two
 * ways. `constructor(public value: string)` declares a parameter beside
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

/** The property symbols that one member mention reaches. */
const symbolsAtMember = (
  checker: ts.TypeChecker,
  node: ts.Node,
): readonly ts.Symbol[] => {
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

interface NameReaderContext {
  hasSymbols: boolean;
  program: ts.Program;
  root: string;
  service: ts.LanguageService;
}

const readerFilesOf = (
  context: NameReaderContext,
  field: FieldName,
  references: readonly ts.ReferencedSymbol[],
): string[] => {
  const namesTheNamesake = namesTheNamesakeOf(field);
  const readers: string[] = [];
  for (const group of references) {
    for (const reference of group.references) {
      if (readsHere(context.program, reference, namesTheNamesake)) {
        readers.push(reference.fileName.replace(`${context.root}/`, ""));
      }
    }
  }
  return readers;
};

const uncachedReadersOfName = (
  context: NameReaderContext,
  field: FieldName,
): string[] => {
  if (isNegativeNumericName(field)) return [];
  const references = context.service.findReferences(
    field.getSourceFile().fileName,
    field.getStart(),
  );
  if (!references && context.hasSymbols) return [];
  return readerFilesOf(
    context,
    field,
    answered(references, `references for ${fieldNameText(field)}`),
  );
};

const readersOfName = (
  context: NameReaderContext,
  cache: Map<FieldName, readonly string[]>,
  field: FieldName,
): string[] => {
  const cached = cache.get(field);
  if (cached) return [...cached];
  const readers = uncachedReadersOfName(context, field);
  cache.set(field, readers);
  return readers;
};

/** Everyone who reads a field, wherever it was written down. */
const readersOf = (
  service: ts.LanguageService,
  program: ts.Program,
  root: string,
  names: readonly FieldName[],
  symbols: readonly ts.Symbol[],
  readersByName: Map<FieldName, readonly string[]>,
  readersBySymbol: ReadonlyMap<ts.Symbol, readonly string[]>,
): string[] => {
  const context = { hasSymbols: symbols.length > 0, program, root, service };
  return unique([
    ...names.flatMap((field) => readersOfName(context, readersByName, field)),
    ...symbols.flatMap((symbol) =>
      answered(readersBySymbol.get(symbol), `readers for ${symbol.name}`),
    ),
  ]);
};

/** Read sites for fields the checker creates without a source declaration. */
const readersOfSymbols = (
  program: ts.Program,
  checker: ts.TypeChecker,
  files: readonly string[],
  symbols: ReadonlySet<ts.Symbol>,
  root: string,
): ReadonlyMap<ts.Symbol, readonly string[]> => {
  const readers = new Map(
    [...symbols].map((symbol): [ts.Symbol, string[]] => [symbol, []]),
  );
  const readSymbolsIn = (file: string): ((node: ts.Node) => void) => {
    const relative = file.replace(`${root}/`, "");
    const read = (node: ts.Node): void => {
      if (namesAMember(node) && readsTheValue(node)) {
        for (const symbol of symbolsAtMember(checker, node)) {
          if (!symbols.has(symbol)) continue;
          const paths = answered(
            readers.get(symbol),
            `reader list for ${symbol.name}`,
          );
          paths.push(relative);
        }
      }
      ts.forEachChild(node, read);
    };
    return read;
  };
  for (const file of files) {
    const source = answered(program.getSourceFile(file), `source file ${file}`);
    readSymbolsIn(file)(source);
  }
  return readers;
};

/** Look at every exported field the repository declares under `src/`. */
export const scanUnreadFields = async (root: string): Promise<Finding[]> => {
  const config = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
  const files = await sourceFilesIn(root);
  const options = compilerOptions(
    root,
    aliasPaths(config.imports),
    config.compilerOptions,
  );
  const service = ts.createLanguageService(
    serviceHost(root, files, options),
    ts.createDocumentRegistry(),
  );
  const program = answered(service.getProgram(), "program for the scan");
  const checker = program.getTypeChecker();
  const fieldsOf = exportedFields(checker);

  // The program also holds every locale JSON that `src/` imports, and every
  // file it reached outside `src/`. Only the TypeScript the walk found counts.
  const scanned = new Set(
    files.filter((f) => f.startsWith(`${root}/${REPORTED}/`)),
  );
  const fields = program
    .getSourceFiles()
    .filter((source) => scanned.has(source.fileName))
    .flatMap((source) =>
      fieldsOf(source).map((field) => ({
        exportedFrom: source.fileName,
        field,
      })),
    );
  const symbols = new Set(fields.flatMap(({ field }) => field.symbols));
  const symbolReaders = readersOfSymbols(
    program,
    checker,
    files,
    symbols,
    root,
  );
  const nameReaders = new Map<FieldName, readonly string[]>();
  const findings: Finding[] = [];
  for (const {
    exportedFrom,
    field: { owner, names, symbols: fieldSymbols },
  } of fields) {
    findings.push({
      exportedFrom: exportedFrom.replace(`${root}/`, ""),
      field: fieldNameText(names[0]),
      // Where a reader has to go to find it, which is where it was written
      // down rather than the shape that hands it on.
      file: names[0].getSourceFile().fileName.replace(`${root}/`, ""),
      owner: ownerPath(owner),
      path: owner,
      verdict: verdictFor(
        readersOf(
          service,
          program,
          root,
          names,
          fieldSymbols,
          nameReaders,
          symbolReaders,
        ),
      ),
    });
  }
  return findings;
};
