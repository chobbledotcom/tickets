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

const compilerOptions = (
  root: string,
  paths: Record<string, string[]>,
): ts.CompilerOptions => ({
  allowImportingTsExtensions: true,
  baseUrl: root,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: "#jsx",
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  paths,
  target: ts.ScriptTarget.ESNext,
});

const serviceHost = (
  root: string,
  files: string[],
  options: ts.CompilerOptions,
): ts.LanguageServiceHost => {
  const texts = new Map<string, string>();
  const read = (file: string): string | undefined => {
    if (!texts.has(file)) {
      try {
        texts.set(file, Deno.readTextFileSync(file));
      } catch {
        // A path the compiler probes but the repository does not have.
        return;
      }
    }
    return texts.get(file);
  };
  const isKind = (path: string, kind: "isFile" | "isDirectory"): boolean => {
    try {
      return Deno.statSync(path)[kind];
    } catch {
      return false;
    }
  };
  return {
    directoryExists: (dir) => isKind(dir, "isDirectory"),
    fileExists: (file) => isKind(file, "isFile"),
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

/** Every exported interface in a file, with its field names. */
const exportedFields = (
  source: ts.SourceFile,
): { owner: string; field: ts.Identifier }[] => {
  const found: { owner: string; field: ts.Identifier }[] = [];
  const visit = (node: ts.Node): void => {
    const exported = ts.canHaveModifiers(node)
      ? ts
          .getModifiers(node)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isInterfaceDeclaration(node) && exported) {
      for (const member of node.members) {
        if (member.name && ts.isIdentifier(member.name)) {
          found.push({ field: member.name, owner: node.name.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
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
  const references = service.findReferences(file, field.getStart()) ?? [];
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
  const program = service.getProgram();
  if (!program) throw new Error("TypeScript built no program for the scan");

  const findings: Finding[] = [];
  for (const file of files.filter((f) => f.startsWith(`${root}/src/`))) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const { owner, field } of exportedFields(source)) {
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
