/**
 * IO shell for the coverage exclusion ratchet: diff HEAD's exclusion list
 * against the merge base on `origin/main` (see "Never add a coverage
 * exclusion" in AGENTS.md). Kept thin so the rules stay in
 * ./exclusion-ratchet.ts and the entry stays a one-liner.
 */

/* jscpd:ignore-start -- imports */
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { fileAtRevision } from "#scripts/file-at-revision.ts";
import {
  type MergeBaseListReader,
  mergeBaseOrThrow,
  type RunCommand,
} from "#scripts/precommit/git.ts";
import {
  EXCLUSIONS_PATH,
  exclusionFindings,
  LEGACY_PATH,
  parseExclusionEntries,
  RATCHET_GUIDE,
} from "./exclusion-ratchet.ts";

/* jscpd:ignore-end */

/**
 * The entries the gate actually enforces, `COVERAGE_EXCLUSIONS`, are the
 * truth. The text parser must account for every one of them: an entry in a
 * shape that the parser skips adds an exclusion without the ratchet to see
 * it. When the parser misses an entry, throw and name the unread entries.
 */
const assertParseCoversRuntime = (
  parsed: readonly string[],
  runtime: readonly string[],
): void => {
  const parsedSet = new Set(parsed);
  const unread = runtime.filter((entry) => !parsedSet.has(entry));
  if (unread.length > 0) {
    throw new Error(
      `The ratchet could not read ${unread.length} exclusion entries in ` +
        `${EXCLUSIONS_PATH}: ${unread.join(", ")}. Write each entry on its ` +
        'own line as "path", or extend parseExclusionEntries.',
    );
  }
};

/** The exclusion entries the merge base holds: from the data module, or from
 * the gate module the list moved out of. Neither file at the base means the
 * base carried no exclusions. */
export const baseEntries: MergeBaseListReader = async (run, mergeBase) => {
  const moved = await fileAtRevision(run, mergeBase, EXCLUSIONS_PATH);
  if (moved !== undefined) return parseExclusionEntries(moved);
  const legacy = await fileAtRevision(run, mergeBase, LEGACY_PATH);
  return legacy === undefined ? [] : parseExclusionEntries(legacy);
};

/** Read HEAD's data module, diff it against the merge base, and return the
 * process exit code with the report printed. `runtimeEntries` is the array
 * the coverage gate imports; the parser must account for all of it. */
export const ratchetExit = async (
  run: RunCommand,
  headSource: string,
  runtimeEntries: readonly string[],
  output: CheckOutput,
): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "ratchet");
  assertParseCoversRuntime(parseExclusionEntries(headSource), runtimeEntries);
  const base = await baseEntries(run, mergeBase);
  return reportCheck({
    found: exclusionFindings(headSource, base),
    guide: RATCHET_GUIDE,
    ...output,
    noun: "added-exclusion",
    success: "The coverage exclusion list adds nothing against origin/main.",
  });
};
