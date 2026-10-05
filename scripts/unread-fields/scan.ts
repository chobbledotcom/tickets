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
import { fieldNameText } from "./fields/names.ts";
import { exportedFields } from "./fields.ts";
import { type Finding, verdictFor } from "./findings.ts";
import { answered, compilerOptions, pathIs, serviceHost } from "./host.ts";
import { ownerPath } from "./identity.ts";
import { readersOfFields } from "./readers.ts";

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
  const readers = readersOfFields({ checker, program, root })(
    fields.map(({ field }) => field),
  );
  return fields.map(({ exportedFrom, field }) => {
    const { owner, names } = field;
    return {
      exportedFrom: exportedFrom.replace(`${root}/`, ""),
      field: fieldNameText(names[0]),
      // Where a reader has to go to find it, which is where it was written
      // down rather than the shape that hands it on.
      file: names[0].getSourceFile().fileName.replace(`${root}/`, ""),
      owner: ownerPath(owner),
      path: owner,
      verdict: verdictFor(
        answered(readers.get(field), `readers for ${fieldNameText(names[0])}`),
      ),
    };
  });
};
