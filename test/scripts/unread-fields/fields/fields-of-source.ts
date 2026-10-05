import ts from "typescript";
import { lazyRef } from "#fp";
import { fieldNameText } from "#scripts/unread-fields/fields/names.ts";
import {
  exportedFields,
  type OwnedField,
} from "#scripts/unread-fields/fields.ts";
import { answered } from "#scripts/unread-fields/host.ts";
import { ownerPath, reaching } from "#scripts/unread-fields/identity.ts";

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
};

const versions = new Map<string, number>();
const [getRootNames, setRootNames] = lazyRef<string[]>(() => []);
const [getService, setService] = lazyRef<
  { dir: string; languageService: ts.LanguageService } | undefined
>(() => undefined);

/** The compiler's view of one small repository on disk. A source can import a
 * file nobody wrote. The miss is the point: the walk then sees no shape
 * behind the name. */
const fieldsHost = (dir: string): ts.LanguageServiceHost => {
  const read = (file: string): string | undefined => {
    try {
      return Deno.readTextFileSync(file);
    } catch {
      // A file nobody wrote reads as absent, never as an error.
      return;
    }
  };
  return {
    directoryExists: ts.sys.directoryExists,
    fileExists: ts.sys.fileExists,
    getCompilationSettings: () => OPTIONS,
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (options: ts.CompilerOptions) =>
      ts.getDefaultLibFilePath(options),
    getDirectories: ts.sys.getDirectories,
    getScriptFileNames: () => getRootNames(),
    getScriptSnapshot: (file: string) => {
      const text = read(file);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getScriptVersion: (file: string) => String(versions.get(file) ?? 0),
    readDirectory: ts.sys.readDirectory,
    readFile: read,
  };
};

/** One language service for every fieldsOf call in this isolate. The parse
 * of the standard library is the costly part of a call. The document
 * registry keeps that parse, so a call after the first compiles only its own
 * small sources. The tests call fieldsOf one after another, so the shared
 * host always reads the one call that runs. */
const fieldsService = (): {
  dir: string;
  languageService: ts.LanguageService;
} => {
  const existing = getService();
  if (existing !== undefined) return existing;
  const dir = Deno.makeTempDirSync({ prefix: "unread-fields-fields-" });
  // Every call in this isolate shares the tree, so the tree goes when the
  // isolate does.
  globalThis.addEventListener("unload", () =>
    Deno.removeSync(dir, { recursive: true }),
  );
  const created = {
    dir,
    languageService: ts.createLanguageService(
      fieldsHost(dir),
      ts.createDocumentRegistry(),
    ),
  };
  setService(created);
  return created;
};

/**
 * Compile a small repository — `shapes.ts` holding `source`, plus any files
 * passed in `more` — and hand back the fields the scanner sees in
 * `shapes.ts`. Write-only: the caller asserts on the paths and names in the
 * answer.
 */
export const fieldsOf = async (
  source: string,
  more: Record<string, string> = {},
): Promise<OwnedField[]> => {
  const { dir, languageService: compiler } = fieldsService();
  const files = { ...more, "shapes.ts": source };
  setRootNames(Object.keys(files).map((file) => `${dir}/${file}`));
  for (const [file, text] of Object.entries(files)) {
    const path = `${dir}/${file}`;
    await Deno.writeTextFile(path, text);
    versions.set(path, (versions.get(path) ?? 0) + 1);
  }
  const program = answered(
    compiler.getProgram(),
    "program for the fields walk",
  );
  const scanned = answered(
    program.getSourceFile(`${dir}/shapes.ts`),
    "the scanned file",
  );
  return exportedFields(program.getTypeChecker())(scanned);
};

/** The readable reach of the first name of every field the scan found. */
export const pathsOf = (fields: readonly OwnedField[]): string[] =>
  fields.map((field) =>
    reaching(ownerPath(field.owner), fieldNameText(field.names[0])),
  );
