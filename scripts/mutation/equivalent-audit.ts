import { isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { createStaticGates, type StaticGate } from "./execution.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import { mutantKeyForPath, parseIgnoreLine } from "./ignore.ts";

interface PhysicalEntry {
  chunk: string;
  column: number;
  index: number;
  key: string;
  line: string;
  lineNumber: number;
  newOperator: string;
  operator: string;
  sourcePath: string;
}

interface ResolvedEntry extends PhysicalEntry {
  file: string;
  mutant: Mutant;
  original: string;
}

export interface EquivalentAuditOptions {
  ignoreFile: string | URL;
  root: string;
  signal?: AbortSignal;
  write: boolean;
}

export interface EquivalentAuditResult {
  checked: number;
  killedByLint: string[];
  killedByTypeCheck: string[];
  retained: number;
}

export interface EquivalentAuditDeps {
  createGates(): Promise<StaticGate[]>;
}

const realDeps: EquivalentAuditDeps = { createGates: createStaticGates };

const chunksOf = (text: string): string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const physicalEntries = (chunks: string[]): PhysicalEntry[] => {
  const seen = new Set<string>();
  return chunks.flatMap((chunk, index) => {
    const line = chunk.replace(/\r?\n$/, "");
    const parsed = parseIgnoreLine(line);
    if (!parsed) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) return [];
      throw new Error(`Malformed equivalent-mutant entry: ${line}`);
    }
    if (seen.has(parsed.key)) {
      throw new Error(`Duplicate equivalent-mutant entry: ${parsed.key}`);
    }
    seen.add(parsed.key);
    const { line: lineNumber, ...rest } = parsed;
    return [{ chunk, index, line, lineNumber, ...rest }];
  });
};

const sourceFile = (root: string, sourcePath: string): string => {
  if (isAbsolute(sourcePath)) {
    throw new Error(`Equivalent-mutant path must be relative: ${sourcePath}`);
  }
  const file = resolve(root, sourcePath);
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(`..${SEPARATOR}`)) {
    throw new Error(
      `Equivalent-mutant path escapes the project: ${sourcePath}`,
    );
  }
  return file;
};

interface SourceMutants {
  mutants: Map<string, Map<string, Mutant>>;
  originals: Map<string, string>;
}

const loadSourceMutants = async (
  root: string,
  entries: PhysicalEntry[],
): Promise<SourceMutants> => {
  const originals = new Map<string, string>();
  const mutants = new Map<string, Map<string, Mutant>>();
  for (const entry of entries) {
    const file = sourceFile(root, entry.sourcePath);
    if (originals.has(file)) continue;
    const original = await Deno.readTextFile(file);
    originals.set(file, original);
    mutants.set(
      file,
      new Map(
        generateMutants(original, file, true).map((mutant) => [
          mutantKeyForPath(entry.sourcePath, mutant),
          mutant,
        ]),
      ),
    );
  }
  return { mutants, originals };
};

const resolveEntries = async (
  root: string,
  entries: PhysicalEntry[],
): Promise<ResolvedEntry[]> => {
  const { mutants, originals } = await loadSourceMutants(root, entries);
  const problems: string[] = [];
  const resolved = entries.flatMap((entry) => {
    const file = sourceFile(root, entry.sourcePath);
    const mutant = mutants.get(file)?.get(entry.key);
    if (!mutant) {
      problems.push(`No generated mutant matches: ${entry.key}`);
      return [];
    }
    return [{ ...entry, file, mutant, original: originals.get(file)! }];
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return resolved;
};

const failedGateFor = async (
  entry: ResolvedEntry,
  gates: StaticGate[],
  signal: AbortSignal,
): Promise<"lint" | "type-check" | null> => {
  await Deno.writeTextFile(
    entry.file,
    applyMutant(entry.original, entry.mutant),
  );
  try {
    for (const gate of gates) {
      if ((await gate.exit(entry.file, signal)) !== 0) {
        return gate.phase;
      }
    }
    return null;
  } finally {
    await Deno.writeTextFile(entry.file, entry.original);
  }
};

interface AuditClassification extends EquivalentAuditResult {
  killedIndexes: Set<number>;
}

const auditEntries = async (
  entries: ResolvedEntry[],
  gates: StaticGate[],
  signal: AbortSignal,
): Promise<AuditClassification> => {
  const files = new Set(entries.map((entry) => entry.file));
  for (const file of files) {
    for (const gate of gates) {
      if ((await gate.exit(file, signal)) === 0) continue;
      throw new Error(`Unmutated ${file} does not pass ${gate.label}.`);
    }
  }

  const killedByLint: string[] = [];
  const killedByTypeCheck: string[] = [];
  const killedIndexes = new Set<number>();
  for (const entry of entries) {
    signal.throwIfAborted();
    const failed = await failedGateFor(entry, gates, signal);
    if (!failed) continue;
    const target = failed === "lint" ? killedByLint : killedByTypeCheck;
    target.push(entry.line);
    killedIndexes.add(entry.index);
  }
  return {
    checked: entries.length,
    killedByLint,
    killedByTypeCheck,
    killedIndexes,
    retained: entries.length - killedIndexes.size,
  };
};

const pruneKilledEntries = async (
  ignoreFile: string | URL,
  originalIgnore: string,
  chunks: string[],
  killedIndexes: Set<number>,
): Promise<void> => {
  if ((await Deno.readTextFile(ignoreFile)) !== originalIgnore) {
    throw new Error("Equivalent-mutant file changed during the audit.");
  }
  await Deno.writeTextFile(
    ignoreFile,
    chunks
      .map((chunk, index) => (killedIndexes.has(index) ? "" : chunk))
      .join(""),
  );
};

/** Apply every listed equivalent and run only lint plus type-check. */
export const auditEquivalentMutants = async (
  options: EquivalentAuditOptions,
  deps: EquivalentAuditDeps = realDeps,
): Promise<EquivalentAuditResult> => {
  const { ignoreFile, root } = options;
  const originalIgnore = await Deno.readTextFile(ignoreFile);
  const chunks = chunksOf(originalIgnore);
  const entries = await resolveEntries(root, physicalEntries(chunks));
  const gates = await deps.createGates();
  const signal = options.signal ?? new AbortController().signal;
  const result = await auditEntries(entries, gates, signal);
  if (options.write && result.killedIndexes.size > 0) {
    await pruneKilledEntries(
      ignoreFile,
      originalIgnore,
      chunks,
      result.killedIndexes,
    );
  }
  return {
    checked: result.checked,
    killedByLint: result.killedByLint,
    killedByTypeCheck: result.killedByTypeCheck,
    retained: result.retained,
  };
};
