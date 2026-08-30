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
import type { FieldName } from "./fields/steps.ts";
import { exportedFields } from "./fields.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, pathIs, serviceHost } from "./host.ts";
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

/** Folders that only add readers, so the scan can tell a field only its tests
 * read from one nothing reads. `test/` is one, and so are the two live
 * end-to-end harnesses, which read production fields the same way. A
 * repository without one of these is normal, so the walk skips it. */
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

  // The program also holds every locale JSON that `src/` imports, and every
  // file it reached outside `src/`. Only the TypeScript the walk found counts.
  const scanned = new Set(
    files.filter((f) => f.startsWith(`${root}/${REPORTED}/`)),
  );
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
