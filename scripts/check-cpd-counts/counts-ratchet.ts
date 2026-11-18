/**
 * The cpd counts ratchet: a branch must not accept more duplicated places than
 * the merge base on `origin/main` accepts. `cfg/cpd-counts.json` holds one
 * place count for each scan, so the ratchet compares two integers for each
 * scan. A count above the base's fails. A count below the base's, and a scan
 * that the branch drops, pass: the counts only fall.
 *
 * The check also holds every scan task that checks or updates a count to the
 * counts file: the task must name `cfg/cpd-counts.json` and a scan name that
 * the file holds. A scan that reports only, such as the css scan, holds no
 * count. See "Code Duplication" in AGENTS.md.
 */

import { flatMap, sortStrings } from "#fp";
import { formatFinding } from "#scripts/check-report.ts";
import {
  COUNTS_PATH,
  readCounts,
  rises,
  type ScanCounts,
} from "#scripts/jscpd/counts.ts";
import { WRAPPER_FLAGS } from "#scripts/jscpd/options.ts";
import { requireValue } from "#shared/required-value.ts";

/** Where a reader finds the rule and the way out. */
export const RATCHET_GUIDE = '"Code Duplication" in AGENTS.md';

/** The script a task runs when that task compares a scan with its count. */
const CPD_SCRIPT = "scripts/cpd.ts";

/** The flags that make a scan read a count. A scan with either one names one.
 * The scan reads the same names, so one declaration names them for both. */
const COUNT_FLAGS = [WRAPPER_FLAGS.check, WRAPPER_FLAGS.update];

/** The separator between two commands in one task. */
const COMMAND_SEPARATOR = "&&";

/** The pattern that finds the value of `flag` in a task command, in the
 * `--flag <value>` and the `--flag=<value>` form. */
const valuePattern = (flag: string): RegExp =>
  new RegExp(`${flag}(?:=|\\s+)(\\S+)`);

const COUNTS_PATTERN = valuePattern(WRAPPER_FLAGS.counts);
const SCAN_PATTERN = valuePattern(WRAPPER_FLAGS.scan);

/** One scan that a task checks or updates, and the counts file and scan name
 * that the task gives it. */
export interface NamedScan {
  counts: string | undefined;
  scan: string | undefined;
  task: string;
}

/** The value that the `pattern` flag names in `command`, or undefined when the
 * command holds no such flag. */
const flagValue = (command: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(command);
  return match === null
    ? undefined
    : requireValue(match[1], `A cpd task names no value: ${match[0]}`);
};

/** The `scripts/cpd.ts` commands of one task, in the order they run. */
const scanCommands = (command: string): string[] =>
  command.split(COMMAND_SEPARATOR).filter((part) => part.includes(CPD_SCRIPT));

/** The scans that the repository's tasks check or update, in task-name
 * order. */
export const checkedScans = (
  tasks: Readonly<Record<string, string>>,
): NamedScan[] =>
  flatMap((task: string) =>
    scanCommands(
      requireValue(tasks[task], `The task ${task} holds no command.`),
    )
      .filter((command) => COUNT_FLAGS.some((flag) => command.includes(flag)))
      .map((command) => ({
        counts: flagValue(command, COUNTS_PATTERN),
        scan: flagValue(command, SCAN_PATTERN),
        task,
      })),
  )(sortStrings(Object.keys(tasks)));

/** The finding lines for each checked scan that names no count the ratchet can
 * read, in task order. */
export const unreadScanFindings = (
  scans: readonly NamedScan[],
  counts: ScanCounts,
): string[] =>
  scans.flatMap(({ counts: path, scan, task }) => {
    if (path !== COUNTS_PATH || scan === undefined) {
      return [
        formatFinding(`deno.json:${task}`, {
          fix: `name --counts ${COUNTS_PATH} and --scan <name>`,
          problem: "is a scan that this check cannot read a count for",
          rule: "unread-scan",
        }),
      ];
    }
    return counts[scan] === undefined
      ? [
          formatFinding(`${COUNTS_PATH}:${scan}`, {
            fix: "run deno task cpd:update to add it",
            problem: "holds no count for a scan that a task checks",
            rule: "missing-count",
          }),
        ]
      : [];
  });

/** The finding lines for each scan whose count `head` holds above `base`, in
 * scan-name order. */
export const riseFindings = (head: ScanCounts, base: ScanCounts): string[] =>
  rises(head, base).map(([scan, count]) =>
    formatFinding(`${COUNTS_PATH}:${scan}`, {
      fix: "merge the duplicated code, then lower the count with --update",
      problem: `records ${count} place(s), up from ${base[scan] ?? 0}`,
      rule: "raised-count",
    }),
  );

/** Every finding for the working tree's counts against the merge base's. A
 * merge base that holds no counts file holds no count to compare, so the check
 * passes: the scans in `deno task cpd` hold the working tree to its counts
 * file. That covers the change that adds the file. */
export const countsFindings = (
  headText: string,
  baseText: string | undefined,
  scans: readonly NamedScan[],
): string[] => {
  const head = readCounts(COUNTS_PATH, headText);
  return [
    ...unreadScanFindings(scans, head),
    ...(baseText === undefined
      ? []
      : riseFindings(head, readCounts(COUNTS_PATH, baseText))),
  ];
};
