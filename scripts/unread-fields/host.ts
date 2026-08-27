/**
 * How the compiler reaches a file, and what it hands back.
 *
 * The compiler probes far more paths than the repository has, so the helpers
 * here answer "not there" rather than fail. That is the documented behaviour
 * of the language service host, not a swallowed error.
 */

import ts from "typescript";

/** What the compiler answered, where its own types allow nothing but this
 * scan's construction rules nothing out. A full language service over a file
 * it has parsed always has these, so nothing reaching here is a state to
 * handle. */
export const answered = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The compiler had no ${what}`);
  return value;
};

/** The two ways a probe can find nothing: no such path, or a path whose parent
 * is a file. Every other failure means a broken checkout, or a permission the
 * scan does not hold. A file dropped for one of those shrinks the report in
 * silence, so the scan raises it. */
const isAbsence = (error: unknown): boolean =>
  error instanceof Deno.errors.NotFound ||
  error instanceof Deno.errors.NotADirectory;

/** Ask the filesystem something, and answer `whenAbsent` where the path is
 * not there. Every other failure is raised. */
const probing =
  <T>(whenAbsent: T) =>
  (look: () => T): T => {
    try {
      return look();
    } catch (error) {
      if (!isAbsence(error)) throw error;
      return whenAbsent;
    }
  };

/** A file's text, or nothing when the repository does not have that path. */
const textOrNothing = (file: string): string | undefined =>
  probing<string | undefined>(undefined)(() => Deno.readTextFileSync(file));

/** Whether a path is a file, or is a directory. A path that is not there is
 * neither, which is what lets the compiler move on to its next candidate. */
export const pathIs =
  (kind: "isFile" | "isDirectory"): ((path: string) => boolean) =>
  (path) =>
    probing(false)(() => Deno.statSync(path)[kind]);

/** The scan never emits and never reads a diagnostic, so only parsing and
 * module resolution matter. `jsx` is set because a `.tsx` file must parse as
 * JSX. The rest tells the compiler how to find a file. */
/** What the repository asks the compiler for, out of its own `deno.json`.
 * Strictness changes what a type means, so a scan that leaves it out reads a
 * different repository from the one Deno checks. */
const asDeclared = (root: string, declared: unknown): ts.CompilerOptions => {
  const { errors, options } = ts.convertCompilerOptionsFromJson(declared, root);
  if (errors.length > 0) {
    const said = errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
      .join("; ");
    throw new Error(`The compiler refused the options in deno.json: ${said}`);
  }
  return options;
};

/** The repository's own options, with the ones the scan needs on top. Only
 * these last few are the scan's to choose: they say where the files are and
 * how to reach one from another, which is the part `deno.json` leaves to the
 * runtime. */
export const compilerOptions = (
  root: string,
  paths: Record<string, string[]>,
  declared: unknown,
): ts.CompilerOptions => ({
  ...asDeclared(root, declared),
  baseUrl: root,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  paths,
  target: ts.ScriptTarget.ESNext,
});

/** The language service's view of the repository. It reads each file once and
 * remembers the answer, misses included, because the compiler asks again. */
export const serviceHost = (
  root: string,
  files: string[],
  options: ts.CompilerOptions,
): ts.LanguageServiceHost => {
  const texts = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (!texts.has(file)) texts.set(file, textOrNothing(file));
    return texts.get(file);
  };
  return {
    directoryExists: pathIs("isDirectory"),
    fileExists: pathIs("isFile"),
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getDirectories: ts.sys.getDirectories,
    getScriptFileNames: () => files,
    getScriptSnapshot: (file) => {
      const text = read(file);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getScriptVersion: () => "1",
    readDirectory: ts.sys.readDirectory,
    readFile: read,
  };
};
