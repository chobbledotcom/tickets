/**
 * Building block for a whole-tree check built from one per-file rule: scan
 * the trees, hand each file to the rule, and report what it found through the
 * house shape. The rule returns each finding with its line and the words
 * `formatFinding` prints.
 */

import { fromFileUrl } from "@std/path";
/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { notCoveredBy } from "#fp";
import { integerAtLeast } from "#shared/validation/number.ts";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "./check-report.ts";
import { readJsonOrThrow, writeJsonFile } from "./read-json.ts";
import { collectFromFiles } from "./walk-files.ts";
/* jscpd:ignore-end */

/** A registry of `{ path: count }`. */
export type Counts = Record<string, number>;

/** Whether any count in `fresh` rose above the number `recorded` holds for
 * the same key — a count that was never recorded starts at zero, so a new
 * entry above zero is a rise too. */
export const countsRose = (recorded: Counts, fresh: Counts): boolean =>
  Object.entries(fresh).some(([key, count]) => count > (recorded[key] ?? 0));

/** One file's findings against its recorded counts: only the findings that
 * sit past their recorded count, in source order, or the one prompt that
 * asks for a fallen count to be recorded. The key decides what one count
 * stands for: a rule for the comment check, a rule-plus-prose identity for
 * the Markdown check. */
/** The findings of the rules the recorded state does not allow, in source
 * order, one per count past its record. */
const risenFindings = <F extends PerFileFinding>(
  findings: readonly F[],
  excess: Map<string, number>,
  keyOf: (finding: F) => string,
  whereOf: (finding: F) => string,
): string[] => {
  const reported = new Map<string, number>();
  const risen: string[] = [];
  for (const finding of findings) {
    const key = keyOf(finding);
    const past = excess.get(key);
    if (past === undefined) continue;
    const shown = reported.get(key) ?? 0;
    if (shown >= past) continue;
    reported.set(key, shown + 1);
    risen.push(formatFinding(whereOf(finding), finding));
  }
  return risen;
};

export const compareCounts = <F extends PerFileFinding>(input: {
  file: string;
  findings: readonly F[];
  current: Counts;
  recorded: Counts;
  keyOf: (finding: F) => string;
  whereOf: (finding: F) => string;
  updateCommand: string;
}): string[] => {
  if (countsRose(input.recorded, input.current)) {
    // How many findings of each rule the recorded state does not allow.
    const excess = new Map<string, number>();
    for (const [key, count] of Object.entries(input.current)) {
      const past = count - (input.recorded[key] ?? 0);
      if (past > 0) excess.set(key, past);
    }
    return risenFindings(input.findings, excess, input.keyOf, input.whereOf);
  }
  const fell = Object.entries(input.recorded).some(
    ([key, count]) => count > (input.current[key] ?? 0),
  );
  if (!fell) return [];
  const parts = Object.entries(input.current).map(
    ([key, count]) => `${key}: ${count}`,
  );
  const summary = parts.length === 0 ? "none" : parts.join(", ");
  return [
    formatFinding(input.file, {
      fix: `run \`${input.updateCommand}\` to record the step`,
      problem: `fewer findings than recorded (${summary})`,
      rule: "improved",
    }),
  ];
};

/** The counts one rule holds in one file: a whole count per rule, never
 * negative. */
const COUNTS_SCHEMA = v.record(v.string(), integerAtLeast(0));

/** The shape a registry file holds: one entry per path. */
const REGISTRY_SCHEMA = v.record(v.string(), COUNTS_SCHEMA);

/** The counts registry at `path`, or a loud failure naming it. */
export const readCounts = async (path: string): Promise<Counts> =>
  await readJsonOrThrow(path, COUNTS_SCHEMA);

/** One per-file ratchet's records: one entry per path, one count per rule
 * or finding identity. */
export type Registry = Record<string, Counts>;

/** Which registry-recording mode the caller asked for on the command line. */
export interface UpdateMode {
  update: boolean;
}

/** The error a contributor meets for the retired `--seed` flag. */
const SEED_ERROR =
  "The --seed flag is gone. A registry only falls. Use --update after a fix, " +
  "or change the registry in a reviewed commit.";

/** Read the recording flag from a command line: `--update` records a step
 * and refuses a rise. The retired `--seed` is refused loudly. */
export const updateMode = (args: readonly string[]): UpdateMode => {
  if (args.includes("--seed")) throw new Error(SEED_ERROR);
  return { update: args.includes("--update") };
};

/** The absolute path of a registry file a check keeps beside its entry
 * script. */
export const registryPath = (from: string, relative: string): string =>
  fromFileUrl(new URL(relative, from));

/**
 * One per-file ratchet's entry wiring: the registry lives beside the
 * calling module at `relative`, the read is validated against the shared
 * registry shape, and the record step runs for the mode `args` name, with
 * the two-level registry rose refusing a rise.
 */
export const ratchetedState = async (
  moduleUrl: string,
  relative: string,
  args: readonly string[],
  fresh: () => Promise<Registry>,
): Promise<Registry> => {
  const path = registryPath(moduleUrl, relative);
  return await recordedState(
    path,
    updateMode(args),
    await readJsonOrThrow(path, REGISTRY_SCHEMA),
    fresh,
    // A count rose in any file, including a file the records never held.
    (recorded, now) =>
      Object.entries(now).some(([path, counts]) =>
        countsRose(recorded[path] ?? {}, counts),
      ),
  );
};

/**
 * One ratchet's whole record step. Without a recording flag it changes
 * nothing. Otherwise it builds the fresh state, records it at `path` when
 * nothing rose, and answers what the check must now compare against: the
 * recorded state when a rise was refused — so the run that follows names
 * the rise for what it is.
 */
export const recordedState = async <T>(
  path: string,
  mode: UpdateMode,
  recorded: T,
  fresh: () => Promise<T>,
  rose: (recorded: T, fresh: T) => boolean,
): Promise<T> => {
  if (!mode.update) return recorded;
  const freshState = await fresh();
  if (!rose(recorded, freshState)) {
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

/**
 * Every registry entry whose key names nothing the check now reads. The
 * lists only shrink, so a stale entry reports itself.
 */
export const staleEntryLines = (
  read: readonly string[],
  keys: readonly string[],
  registry: string,
  fix: string,
): string[] =>
  notCoveredBy(
    (path: string) => path,
    read,
  )(keys)
    .sort()
    .map((path) =>
      formatFinding(path, {
        fix,
        problem: `entry names nothing the check reads (${registry})`,
        rule: "stale-entry",
      }),
    );

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
