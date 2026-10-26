/**
 * The tracked journal of finished mutation runs (issue #2301): one JSON line
 * per conclusive run, carrying the score and survivor counts, so a drop in
 * assertion strength is visible between runs instead of living only in a
 * terminal that has scrolled away.
 *
 * The isolated run's child writes what it measured (`summary.json` in the
 * run's own directory); the supervisor — the process that stays in the live
 * checkout — reads it back and appends the journal line, stamped with the run
 * id and the checkout's commit. A run stopped by its deadline or an interrupt
 * publishes no score, matching the terminal report's rule for partial runs.
 */

import { join } from "@std/path";
import * as v from "valibot";
import { nonBlankLines } from "#scripts/lines.ts";
import { rel } from "#scripts/project-root.ts";
import { readJsonOrNull } from "#scripts/read-json.ts";
import { errorMessage } from "#shared/error-message.ts";
import { MUTATION_RUN_ROOT_ENV } from "./isolation-state.ts";
import { type MutantResult, summarize } from "./summary.ts";
import { writeWholeOrNotAtAll } from "./write-whole.ts";

export const RUN_SUMMARY_FILE = "summary.json";
export const MUTATION_JOURNAL_PATH = "scripts/mutation/runs.jsonl";

/** What one finished run measured, as the child reports it. */
export const MutationRunSummarySchema = v.object({
  effective: v.pipe(v.number(), v.integer()),
  exhaustive: v.boolean(),
  finishedAt: v.string(),
  harness: v.boolean(),
  ignored: v.pipe(v.number(), v.integer()),
  killed: v.pipe(v.number(), v.integer()),
  score: v.number(),
  sources: v.array(v.string()),
  survived: v.pipe(v.number(), v.integer()),
  tests: v.array(v.string()),
  total: v.pipe(v.number(), v.integer()),
});

export type MutationRunSummary = v.InferOutput<typeof MutationRunSummarySchema>;

/** One journal line: the summary plus the run and checkout it belongs to. */
export const MutationJournalEntrySchema = v.intersect([
  MutationRunSummarySchema,
  v.object({
    commit: v.nullable(v.string()),
    id: v.string(),
  }),
]);

export type MutationJournalEntry = v.InferOutput<
  typeof MutationJournalEntrySchema
>;

/** Write the child's summary in one step, so a supervisor reading mid-write
 *  sees the old file or the new one, never half of one. */
export const writeRunSummary = async (
  runRoot: string,
  summary: MutationRunSummary,
): Promise<void> =>
  writeWholeOrNotAtAll(
    runSummaryPath(runRoot),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

/** The summary the child of `runRoot` wrote, or null when there is none — a
 *  run that never reached a verdict publishes nothing. */
export const readRunSummary = (
  runRoot: string,
): Promise<MutationRunSummary | null> =>
  readJsonOrNull(runSummaryPath(runRoot), MutationRunSummarySchema);

export const runSummaryPath = (runRoot: string): string =>
  join(runRoot, RUN_SUMMARY_FILE);

/** The journal line for a finished run. Pure, so the fold from the run's
 *  record and the child's summary is directly testable. */
export const journalEntry = (
  id: string,
  commit: string | null,
  summary: MutationRunSummary,
): MutationJournalEntry => ({ commit, id, ...summary });

/** Append one run to the tracked journal. One line per call, written through
 *  an append-mode handle, so runs that finish side by side cannot tear each
 *  other's line. */
export const appendJournalEntry = async (
  root: string,
  entry: MutationJournalEntry,
): Promise<void> => {
  const path = join(root, MUTATION_JOURNAL_PATH);
  const file = await Deno.open(path, {
    append: true,
    create: true,
  });
  try {
    await file.write(new TextEncoder().encode(`${JSON.stringify(entry)}\n`));
  } finally {
    file.close();
  }
};

/** The journal's lines, oldest first. A torn or wrong-shaped line throws:
 *  a run's published numbers must never silently vanish. */
export const readJournal = async (
  root: string,
): Promise<MutationJournalEntry[]> => {
  const text = await Deno.readTextFile(join(root, MUTATION_JOURNAL_PATH));
  return nonBlankLines(text).map((line) =>
    v.parse(MutationJournalEntrySchema, JSON.parse(line)),
  );
};

/** Publish a finished run's numbers for the tracked journal (issue #2301).
 * A failure here is a record-keeping failure: it must not turn a finished
 * run's verdict into a crash, so it is reported and the run's own exit code
 * stands. Outside an isolated snapshot there is no run to publish into, so an
 * env-less run writes nothing. */
export const publishRunSummary = async (
  run: {
    exhaustive: boolean;
    useHarness: boolean;
    sourceFiles: readonly string[];
    testFiles: readonly string[];
  },
  results: readonly MutantResult[],
): Promise<void> => {
  const runRoot = Deno.env.get(MUTATION_RUN_ROOT_ENV);
  if (runRoot === undefined) return;
  try {
    const { effective, ignored, killed, score, survived, total } = summarize([
      ...results,
    ]);
    await writeRunSummary(runRoot, {
      effective,
      exhaustive: run.exhaustive,
      finishedAt: new Date().toISOString(),
      harness: run.useHarness,
      ignored,
      killed,
      score,
      sources: run.sourceFiles.map((file) => rel(file)),
      survived,
      tests: run.testFiles.map((file) => rel(file)),
      total,
    });
  } catch (error) {
    console.error(
      `The run's numbers could not be published for the mutation journal: ${errorMessage(error)}`,
    );
  }
};
