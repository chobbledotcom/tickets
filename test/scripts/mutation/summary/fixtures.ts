import {
  type MutantResult,
  type Summary,
  summarize,
} from "#scripts/mutation/summary.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { withEnv } from "#test-utils/env.ts";

/** One mutant result, shaped for the summary functions under test. */
export const fakeResult = (
  status: MutantResult["status"],
  line: number,
  operator: string,
  newOperator: string,
  file = `${projectRoot}/src/example.ts`,
): MutantResult => ({
  detectedBy: status === "killed" ? "direct-tests" : null,
  file,
  mutant: {
    anchor: `fn${line}`,
    column: 3,
    end: 1,
    line,
    newOperator,
    operator,
    start: 0,
  },
  status,
  timings: [],
});

export const withStepSummary = async (
  path: string | null,
  run: () => void,
): Promise<string> => {
  using _env = withEnv({ GITHUB_STEP_SUMMARY: path ?? undefined });
  run();
  return path === null ? "" : await Deno.readTextFile(path).catch(() => "");
};

/** Colour codes removed, so a report can be compared line by line. */
export const plain = (line: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
  line.replace(/\u001b\[[0-9;]*m/g, "");

/** One killed mutant carrying lint and test phase timings. */
export const timingSummary = (
  status: MutantResult["status"] = "killed",
): Summary => {
  const result = fakeResult(status, 1, "true", "false");
  result.timings = [
    { durationMs: 4, phase: "lint" },
    { durationMs: 10, phase: "direct-tests" },
  ];
  return summarize([result]);
};
