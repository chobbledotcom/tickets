import type { Mutant } from "#scripts/mutation/generate.ts";
import type { IgnoreList } from "#scripts/mutation/ignore.ts";
import type { MutantResult } from "#scripts/mutation/summary.ts";
import { projectRoot } from "#scripts/project-root.ts";

export const file = `${projectRoot}/src/example.ts`;

/** A mutant told apart from its neighbours by `nth`, which names the thing it
 * sits inside — that is what an entry records, so it is what has to differ. */
export const mutant = (
  nth: number,
  operator = "??",
  newOperator = "||",
): Mutant => ({
  anchor: `fn${nth}`,
  column: 5,
  end: 1,
  line: nth,
  newOperator,
  operator,
  start: 0,
});

export const result = (
  status: MutantResult["status"],
  line: number,
): MutantResult => ({
  detectedBy: null,
  file,
  mutant: mutant(line),
  status,
  timings: [],
});

/** An ignore list of entries against `src/example.ts` unless a line names its
 * own path, which is how a neighbouring file's entry is written. */
export const ignoreList = (
  keys: (string | { key: string; sourcePath: string })[],
): IgnoreList => {
  const entries = keys.map((entry) =>
    typeof entry === "string"
      ? { key: entry, sourcePath: "src/example.ts" }
      : entry,
  );
  return { entries, keys: new Set(entries.map((entry) => entry.key)) };
};
