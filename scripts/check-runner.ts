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
import { readJsonOrThrow } from "./read-json.ts";
import { collectFromFiles } from "./walk-files.ts";

/** A registry of `{ path: count }`. */
export type Counts = Record<string, number>;

/** The counts registry at `path`, or a loud failure naming it. */
export const readCounts = async (path: string): Promise<Counts> =>
  await readJsonOrThrow(path, v.record(v.string(), v.number()));

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
        rule(file, content).map((issue) =>
          formatFinding(`${file}:${issue.line}`, issue),
        ),
      ),
      ...words,
    });
