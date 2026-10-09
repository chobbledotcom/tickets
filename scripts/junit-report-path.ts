import { join } from "node:path";

/** The JUnit report a run writes: the caller's path, or a fresh temporary
 * report for a focused run — the run where a crash gets chased. Kept in its
 * own module so tests can load this logic without dragging the runner
 * shell's uninstrumented lines into the coverage gate. The temporary
 * directory comes back so the caller can remove it after the run. */
export type JUnitReport = {
  /** The directory to remove after the run, or undefined when the caller
   * owns the path. */
  dir: string | undefined;
  path: string;
};

export const junitReportForRun = async (
  junitPath?: string,
): Promise<JUnitReport> => {
  if (junitPath !== undefined) return { dir: undefined, path: junitPath };
  const dir = await Deno.makeTempDir({ prefix: "test-junit-" });
  return { dir, path: join(dir, "junit.xml") };
};

/** The JUnit path a caller already forwarded inside the test arguments, in
 * either flag form. */
export const junitPathInArgs = (
  extraArgs: readonly string[],
): string | undefined => {
  for (const [index, arg] of extraArgs.entries()) {
    if (arg === "--junit-path") return extraArgs[index + 1];
    if (arg.startsWith("--junit-path="))
      return arg.slice("--junit-path=".length);
  }
  return;
};
