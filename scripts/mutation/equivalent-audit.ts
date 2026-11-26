import {
  type RegistryScope,
  type ResolvedEntry,
  readEquivalentRegistry,
  registryEntryId,
  registryRewrites,
} from "./equivalent-registry.ts";
import { type ProofReview, proofReviews } from "./equivalent-review.ts";
import { createStaticGates, type StaticGate } from "./execution.ts";
import { applyMutant } from "./generate.ts";
import { writeCheckedFiles } from "./snapshot-copy-back.ts";

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

export interface EquivalentAuditOptions extends RegistryScope {
  signal?: AbortSignal;
  write: boolean;
}

export interface EquivalentAuditResult {
  checked: number;
  killedByLint: string[];
  killedByTests: string[];
  killedByTypeCheck: string[];
  /** Records whose exact keys no longer resolve. */
  missing: string[];
  /** Confirmed entries that survive the attempted checks. */
  retained: number;
  /** Surviving entries that need a new proof. */
  unconfirmed: ProofReview[];
  /** Entries whose sources have no mapped direct tests. */
  untested: string[];
}

export interface EquivalentAuditDeps {
  createGates(): Promise<StaticGate[]>;
  /** Run each gate survivor against its mapped direct tests. */
  reprove?(
    entries: ResolvedEntry[],
    context: ReproveContext,
  ): Promise<ReproveOutcome>;
}

const realDeps: EquivalentAuditDeps = { createGates: createStaticGates };

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

interface AuditClassification {
  killedByLint: string[];
  killedByTypeCheck: string[];
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
    killedChunks.add(registryEntryId(entry));
  }
  return { killedByLint, killedByTypeCheck, killedChunks };
};

const reviewSurvivors = async (
  survivors: ResolvedEntry[],
  killedChunks: ReadonlySet<string>,
): Promise<ProofReview[]> => {
  const reviewEntry = proofReviews();
  const reviews: ProofReview[] = [];
  for (const entry of survivors) {
    if (killedChunks.has(registryEntryId(entry))) continue;
    const review = await reviewEntry(entry);
    if (review !== null) reviews.push(review);
  }
  return reviews;
};

/** Run checks against exact matches, then classify the remaining records. */
export const auditEquivalentMutants = async (
  options: EquivalentAuditOptions,
  deps: EquivalentAuditDeps = realDeps,
): Promise<EquivalentAuditResult> => {
  const { root } = options;
  const { missing, registries, resolved } =
    await readEquivalentRegistry(options);
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const gates = resolved.length === 0 ? [] : await deps.createGates();
  const staticResult = await auditEntries(resolved, {
    gates,
    signal,
    workspace: root,
  });

  const { killedChunks } = staticResult;
  let killedByTests: string[] = [];
  let untested: string[] = [];
  const survivors = resolved.filter(
    (entry) => !killedChunks.has(registryEntryId(entry)),
  );
  if (deps.reprove && survivors.length > 0) {
    const reproved = await deps.reprove(survivors, { root, signal });
    for (const id of reproved.killedChunks) killedChunks.add(id);
    killedByTests = reproved.killedLines;
    untested = reproved.untested;
  }

  const unconfirmed = await reviewSurvivors(survivors, killedChunks);

  signal.throwIfAborted();
  if (options.write && (killedChunks.size > 0 || missing.length > 0)) {
    const removals = new Map<string, string>();
    for (const id of killedChunks) removals.set(id, "");
    for (const entry of missing) removals.set(registryEntryId(entry), "");
    const changes = registryRewrites(registries, removals);
    await writeCheckedFiles(root, changes, (entry) => entry.after);
  }
  return {
    checked: resolved.length + missing.length,
    killedByLint: staticResult.killedByLint,
    killedByTests,
    killedByTypeCheck: staticResult.killedByTypeCheck,
    missing: missing.map((entry) => entry.line),
    retained: resolved.length - killedChunks.size - unconfirmed.length,
    unconfirmed,
    untested,
  };
};
