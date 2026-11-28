import { isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { requiredMapValue } from "#fp";
import { readTextFileOrNull } from "#scripts/not-found.ts";
import { generateMutants, type Mutant } from "./generate.ts";
import {
  mutantKeyForPath,
  type ParsedIgnoreLine,
  parseIgnoreLine,
  registryFilePath,
} from "./ignore.ts";
import type { WrittenFile } from "./snapshot-copy-back.ts";

interface RegistryFile {
  before: string;
  chunks: string[];
  file: string;
}

interface PhysicalEntry extends ParsedIgnoreLine {
  chunk: string;
  index: number;
  line: string;
  registry: number;
}

export interface ResolvedEntry extends PhysicalEntry {
  file: string;
  mutant: Mutant;
  original: string;
}

export interface SourceMutants {
  file: string;
  mutants: ReadonlyMap<string, Mutant>;
  original: string;
}

interface EquivalentRegistry {
  missing: PhysicalEntry[];
  registries: RegistryFile[];
  resolved: ResolvedEntry[];
}

export interface RegistryScope {
  ignoreFiles: (string | URL)[];
  root: string;
  sources?: readonly string[];
}

export const registryEntryId = ({ registry, index }: PhysicalEntry): string =>
  `${registry}:${index}`;

export const whyPathUnusable = (
  sourcePath: string,
  root: string,
): string | null => {
  if (isAbsolute(sourcePath)) return "path must be relative to the project";
  const canonical = relative(root, resolve(root, sourcePath));
  if (canonical === ".." || canonical.startsWith(`..${SEPARATOR}`)) {
    return "path escapes the project";
  }
  if (canonical === "") return "path must name a file";
  return canonical === sourcePath
    ? null
    : `path must be written as "${canonical}"`;
};

const requireSourcePath = (sourcePath: string, root: string): void => {
  const problem = whyPathUnusable(sourcePath, root);
  if (problem !== null) {
    throw new Error(`Equivalent-mutant ${problem}: ${sourcePath}`);
  }
};

const readRegistryFile = async (
  path: string | URL,
  root: string,
): Promise<RegistryFile> => {
  const file = resolve(root, registryFilePath(path));
  const before = await Deno.readTextFile(file);
  return {
    before,
    chunks: before.match(/[^\n]*\n|[^\n]+$/g) ?? [],
    file: relative(root, file),
  };
};

const readPhysicalEntries = (registries: RegistryFile[]): PhysicalEntry[] => {
  const seen = new Set<string>();
  const entries: PhysicalEntry[] = [];
  for (const [registry, { chunks }] of registries.entries()) {
    for (const [index, chunk] of chunks.entries()) {
      const line = chunk.replace(/\r?\n$/, "");
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const parsed = parseIgnoreLine(line);
      if (!parsed) {
        throw new Error(`Malformed equivalent-mutant entry: ${line}`);
      }
      if (seen.has(parsed.key)) {
        throw new Error(`Duplicate equivalent-mutant entry: ${parsed.key}`);
      }
      seen.add(parsed.key);
      entries.push({ ...parsed, chunk, index, line, registry });
    }
  }
  return entries;
};

export const readSourceMutants = async (
  root: string,
  sourcePath: string,
): Promise<SourceMutants | null> => {
  const file = resolve(root, sourcePath);
  const original = await readTextFileOrNull(file);
  if (original === null) return null;
  const mutants = new Map<string, Mutant>();
  for (const mutant of generateMutants(original, file, true)) {
    mutants.set(mutantKeyForPath(sourcePath, mutant), mutant);
  }
  return { file, mutants, original };
};

/** Load every registry line, but only read source files in scope. */
export const readEquivalentRegistry = async ({
  ignoreFiles,
  root,
  sources,
}: RegistryScope): Promise<EquivalentRegistry> => {
  const scope = new Set(sources);
  for (const source of scope) requireSourcePath(source, root);
  const registries = await Promise.all(
    ignoreFiles.map((path) => readRegistryFile(path, root)),
  );
  const entries = readPhysicalEntries(registries).filter(
    (entry) => scope.size === 0 || scope.has(entry.sourcePath),
  );
  const bySource = new Map<string, SourceMutants | null>();
  for (const { sourcePath } of entries) {
    if (bySource.has(sourcePath)) continue;
    requireSourcePath(sourcePath, root);
    bySource.set(sourcePath, await readSourceMutants(root, sourcePath));
  }
  const resolved: ResolvedEntry[] = [];
  const missing: PhysicalEntry[] = [];
  for (const entry of entries) {
    const source = requiredMapValue(bySource, entry.sourcePath);
    const mutant = source?.mutants.get(entry.key);
    if (source === null || mutant === undefined) {
      missing.push(entry);
    } else {
      const { file, original } = source;
      resolved.push({ ...entry, file, mutant, original });
    }
  }
  return { missing, registries, resolved };
};

/** Keep all text outside the selected lines verbatim. */
export const registryRewrites = (
  registries: RegistryFile[],
  replacements: ReadonlyMap<string, string>,
): WrittenFile[] => {
  const changes: WrittenFile[] = [];
  for (const [registry, { before, chunks, file }] of registries.entries()) {
    const after = chunks
      .map((chunk, index) => replacements.get(`${registry}:${index}`) ?? chunk)
      .join("");
    if (after !== before) changes.push({ after, before, file });
  }
  return changes;
};
