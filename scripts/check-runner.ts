/**
 * Building block for a whole-tree check built from one per-file rule: scan
 * the trees, hand each file to the rule, and report what it found through the
 * house shape. The rule returns each finding with its line and the words
 * `formatFinding` prints.
 */

import * as v from "valibot";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "./check-report.ts";
import { readJsonOrThrow, writeJsonFile } from "./read-json.ts";
import { collectFromFiles } from "./walk-files.ts";

/** A registry of `{ path: count }`. */
export type Counts = Record<string, number>;

/** Whether any count in `fresh` rose above the number `recorded` holds for
 * the same key — a count that was never recorded starts at zero, so a new
 * entry above zero is a rise too. */
export const countsRose = (recorded: Counts, fresh: Counts): boolean =>
  Object.entries(fresh).some(([key, count]) => count > (recorded[key] ?? 0));

/** The counts registry at `path`, or a loud failure naming it. */
export const readCounts = async (path: string): Promise<Counts> =>
  await readJsonOrThrow(path, v.record(v.string(), v.number()));

/** Which registry-recording mode the caller asked for on the command line. */
export interface UpdateMode {
  seed: boolean;
  update: boolean;
}

/** Read the recording flags from a command line: `--update` records a step
 * and refuses a rise; `--seed` records fresh state whatever it holds. */
export const updateMode = (args: readonly string[]): UpdateMode => ({
  seed: args.includes("--seed"),
  update: args.includes("--update"),
});

/**
 * One ratchet's whole record step. Without a recording flag it changes
 * nothing. Otherwise it builds the fresh state, records it at `path` when
 * allowed, and answers what the check must now compare against: the fresh
 * state when recorded, the old one when a rise was refused — so the run
 * that follows names the rise for what it is.
 */
export const recordedState = async <T>(
  path: string,
  mode: UpdateMode,
  recorded: T,
  fresh: () => Promise<T>,
  rose: (recorded: T, fresh: T) => boolean,
): Promise<T> => {
  if (!mode.update && !mode.seed) return recorded;
  const freshState = await fresh();
  if (mode.seed || !rose(recorded, freshState)) {
    await writeJsonFile(path, freshState);
    return freshState;
  }
  return recorded;
};

/** One finding a per-file rule reports. The path is added while scanning. */
export interface PerFileFinding {
  /** How to put it right. */
  fix: string;
  /** The line the finding sits on, 1-based. */
  line: number;
  /** What was found. */
  problem: string;
  rule: string;
}

/** A check's own words for its report: where the rule is written down, what
 * one finding is called, and what to say when nothing was found. */
export interface CheckWords {
  guide: string;
  noun: string;
  success: string;
}

/** Every finding of one file, written in the house format. */
export const fileFindingLines = (
  file: string,
  findings: readonly PerFileFinding[],
): string[] =>
  findings.map((issue) => formatFinding(`${file}:${issue.line}`, issue));

/** Build a whole-tree check from one per-file rule over one collector. */
export const perFileCheck =
  (
    collect: (root: string) => Promise<string[]>,
    rule: (file: string, content: string) => PerFileFinding[],
    words: CheckWords,
  ): ((roots: readonly string[], output: CheckOutput) => Promise<number>) =>
  async (roots, output) =>
    reportCheck({
      ...output,
      found: await collectFromFiles(roots, collect, (file, content) =>
        fileFindingLines(file, rule(file, content)),
      ),
      ...words,
    });
