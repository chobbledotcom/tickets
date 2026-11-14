/**
 * Re-paired clones: the one rise the jscpd baseline ratchet accepts.
 *
 * jscpd gives a clone pair one fingerprint. When a branch deletes one side of
 * a pair, the scan pairs the other side with a new partner, and that pair has
 * a new fingerprint. The code the branch left alone did not change, so the
 * ratchet accepts a new clone when the branch changed neither of its files.
 * See "Code Duplication" in AGENTS.md.
 */

import { relative } from "node:path";
import * as v from "valibot";
import { scanCommands } from "./baseline-ratchet.ts";

/** One clone the scan calls new: the two files that hold it, as paths from
 * the repository root. */
export interface NewClone {
  first: string;
  second: string;
}

/** The part of the jscpd JSON report that names each clone's files and says
 * whether the baseline holds the clone. */
const REPORT_SCHEMA = v.object({
  duplicates: v.array(
    v.object({
      firstFile: v.object({ name: v.string() }),
      isNew: v.boolean(),
      secondFile: v.object({ name: v.string() }),
    }),
  ),
});

/** The clones in a parsed jscpd report that the scan's baseline does not
 * hold. The report names files by absolute path, so `root` makes them
 * relative. */
export const newClones = (report: unknown, root: string): NewClone[] =>
  v
    .parse(REPORT_SCHEMA, report)
    .duplicates.filter(({ isNew }) => isNew)
    .map(({ firstFile, secondFile }) => ({
      first: relative(root, firstFile.name),
      second: relative(root, secondFile.name),
    }));

/** How many of `clones` are re-pairs: the branch changed neither file. */
export const rePairCount = (
  clones: readonly NewClone[],
  isUnchanged: (path: string) => boolean,
): number =>
  clones.filter(
    ({ first, second }) => isUnchanged(first) && isUnchanged(second),
  ).length;

/** One scan in a task command: its config, then its committed baseline. */
const SCAN_FLAGS = /--config(?:=|\s+)(\S+)\s+--baseline(?:=|\s+)(\S+)/g;

/** The config of the scan task that names `baselinePath`. A baseline that no
 * scan names has no scan to repeat, so the lookup fails loudly. */
export const scanConfigFor = (
  tasks: Readonly<Record<string, string>>,
  baselinePath: string,
): string => {
  const scans = scanCommands(tasks).flatMap((command) => [
    ...command.matchAll(SCAN_FLAGS),
  ]);
  const scan = scans.find((match) => match[2] === baselinePath);
  if (scan?.[1] === undefined) {
    throw new Error(`No cpd task scans with the baseline ${baselinePath}.`);
  }
  return scan[1];
};
