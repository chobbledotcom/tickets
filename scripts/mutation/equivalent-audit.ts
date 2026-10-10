import { isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { shortHash } from "#scripts/checksum.ts";
import { createStaticGates, type StaticGate } from "./execution.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import {
  mutantKeyForPath,
  parseIgnoreLine,
  registryFilePath,
} from "./ignore.ts";
import { writeWholeOrNotAtAll } from "./write-whole.ts";

interface PhysicalEntry {
  anchor: string;
  chunk: string;
  index: number;
  key: string;
  line: string;
  newOperator: string;
  operator: string;
  reason: string;
  /** Which registry file the entry lives in, as an index into the file list. */
  registry: number;
  sourcePath: string;
  stamp: string;
}

/** One entry that resolved to a real mutant in the current source. The
 * distinguishing-input phase (equivalent-reproof.ts) runs against these. */
export interface ResolvedEntry extends PhysicalEntry {
  file: string;
  mutant: Mutant;
  original: string;
}

/** What the audit's distinguishing-input phase needs to run one sweep. */
export interface ReproveContext {
  root: string;
  signal: AbortSignal;
}

/** The entries a test run killed: their registry chunks, for pruning, and
 * their lines, for the report. */
export interface ReproveOutcome {
  killedChunks: Set<string>;
  killedLines: string[];
  /** Entries whose source has no direct test to distinguish with: left
   * standing, and owed a note in the report. */
  untested: string[];
}

interface GateContext {
  gates: StaticGate[];
  signal: AbortSignal;
  workspace: string;
}

const failedGate = async (
  file: string,
  context: GateContext,
): Promise<StaticGate | null> => {
  for (const gate of context.gates) {
    if ((await gate.exit(file, context.workspace, context.signal)) !== 0) {
      return gate;
    }
  }
  return null;
};

/** One registry file's text, split into prune-able line chunks. */
interface RegistryFile {
  chunks: string[];
  file: string | URL;
  original: string;
}

export interface EquivalentAuditOptions {
  ignoreFiles: (string | URL)[];
  root: string;
  signal?: AbortSignal;
  write: boolean;
}

export interface EquivalentAuditResult {
  checked: number;
  killedByLint: string[];
  /** Entries the distinguishing-input phase dropped (only with a `reprove`
   * dep, which the audit command passes for `--tests`). */
  killedByTests: string[];
  killedByTypeCheck: string[];
  /** Entries still suppressing: confirmed, gate-passing, and — under a
   * reprove dep — surviving the direct tests too. */
  retained: number;
  /** Entries whose stamp predates the source text: skipped, never pruned, and
   * owed a person's re-derivation. */
  unconfirmed: string[];
  /** Entries the reprove phase could not attempt because their source has no
   * direct test to distinguish with. They keep suppressing. */
  untested: string[];
}

export interface EquivalentAuditDeps {
  createGates(): Promise<StaticGate[]>;
  /** The distinguishing-input phase. Runs each gate-surviving confirmed
   * entry's mutant against its mapped direct tests and reports the kills. */
  reprove?(
    entries: ResolvedEntry[],
    context: ReproveContext,
  ): Promise<ReproveOutcome>;
}

const realDeps: EquivalentAuditDeps = { createGates: createStaticGates };

const chunksOf = (text: string): string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const physicalEntries = (
  registry: number,
  chunks: string[],
  seen: Set<string>,
): PhysicalEntry[] =>
  chunks.flatMap((chunk, index) => {
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
    return [{ chunk, index, line, registry, ...parsed }];
  });

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
  context: GateContext,
): Promise<"lint" | "type-check" | null> => {
  await Deno.writeTextFile(
    entry.file,
    applyMutant(entry.original, entry.mutant),
  );
  try {
    return (await failedGate(entry.file, context))?.phase ?? null;
  } finally {
    await Deno.writeTextFile(entry.file, entry.original);
  }
};

interface AuditClassification extends EquivalentAuditResult {
  /** Killed entries as `${registry}:${index}` chunk coordinates. */
  killedChunks: Set<string>;
}

const auditEntries = async (
  entries: ResolvedEntry[],
  context: GateContext,
): Promise<AuditClassification> => {
  const files = new Set(entries.map((entry) => entry.file));
  for (const file of files) {
    const failed = await failedGate(file, context);
    if (failed) {
      throw new Error(`Unmutated ${file} does not pass ${failed.label}.`);
    }
  }

  const killedByLint: string[] = [];
  const killedByTypeCheck: string[] = [];
  const killedChunks = new Set<string>();
  for (const entry of entries) {
    context.signal.throwIfAborted();
    const failed = await failedGateFor(entry, context);
    if (!failed) continue;
    const target = failed === "lint" ? killedByLint : killedByTypeCheck;
    target.push(entry.line);
    killedChunks.add(`${entry.registry}:${entry.index}`);
  }
  return {
    checked: entries.length,
    killedByLint,
    killedByTests: [],
    killedByTypeCheck,
    killedChunks,
    retained: entries.length - killedChunks.size,
    unconfirmed: [],
    untested: [],
  };
};

/**
 * The stamp dates the proof: it is the source file's text as it stood when a
 * person last re-derived the reason. A file that has changed since leaves the
 * entry unconfirmed — the audit skips it (no gate check, no prune; a
 * re-derived entry gets its gate check then) and hands it to a person.
 */
const splitByStamp = (
  entries: ResolvedEntry[],
): { confirmed: ResolvedEntry[]; unconfirmed: string[] } => {
  const confirmed: ResolvedEntry[] = [];
  const unconfirmed: string[] = [];
  for (const entry of entries) {
    if (entry.stamp === `audited:${shortHash(entry.original)}`) {
      confirmed.push(entry);
    } else {
      unconfirmed.push(entry.line);
    }
  }
  return { confirmed, unconfirmed };
};

const pruneKilledEntries = async (
  registries: RegistryFile[],
  killedChunks: Set<string>,
): Promise<void> => {
  for (const [registry, { chunks, file, original }] of registries.entries()) {
    const kept = chunks
      .map((chunk, index) =>
        killedChunks.has(`${registry}:${index}`) ? "" : chunk,
      )
      .join("");
    if (kept === original) continue;
    if ((await Deno.readTextFile(file)) !== original) {
      throw new Error("Equivalent-mutant file changed during the audit.");
    }
    await writeWholeOrNotAtAll(registryFilePath(file), kept);
  }
};

/** Apply every listed equivalent and run only lint plus type-check — plus,
 * under a `reprove` dep, each confirmed gate-survivor's mapped direct tests. */
export const auditEquivalentMutants = async (
  options: EquivalentAuditOptions,
  deps: EquivalentAuditDeps = realDeps,
): Promise<EquivalentAuditResult> => {
  const { ignoreFiles, root } = options;
  const registries: RegistryFile[] = await Promise.all(
    ignoreFiles.map(async (file) => {
      const original = await Deno.readTextFile(file);
      return { chunks: chunksOf(original), file, original };
    }),
  );
  const seen = new Set<string>();
  const entries = await resolveEntries(
    root,
    registries.flatMap(({ chunks }, registry) =>
      physicalEntries(registry, chunks, seen),
    ),
  );
  const gates = await deps.createGates();
  const signal = options.signal ?? new AbortController().signal;
  const { confirmed, unconfirmed } = splitByStamp(entries);
  const staticResult = await auditEntries(confirmed, {
    gates,
    signal,
    workspace: root,
  });

  let killedChunks = staticResult.killedChunks;
  let killedByTests: string[] = [];
  let untested: string[] = [];
  if (deps.reprove) {
    const survivors = confirmed.filter(
      (entry) => !killedChunks.has(`${entry.registry}:${entry.index}`),
    );
    if (survivors.length > 0) {
      const reproved = await deps.reprove(survivors, { root, signal });
      killedChunks = new Set([...killedChunks, ...reproved.killedChunks]);
      killedByTests = reproved.killedLines;
      untested = reproved.untested;
    }
  }

  if (options.write && killedChunks.size > 0) {
    await pruneKilledEntries(registries, killedChunks);
  }
  return {
    checked: entries.length,
    killedByLint: staticResult.killedByLint,
    killedByTests,
    killedByTypeCheck: staticResult.killedByTypeCheck,
    retained: entries.length - killedChunks.size - unconfirmed.length,
    unconfirmed,
    untested,
  };
};
