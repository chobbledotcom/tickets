import { join } from "node:path";

/** The JUnit report a run writes: the caller's path, or a fresh temporary
 * report for a focused run — the run where a crash gets chased. Kept in its
 * own module so tests can load this logic without dragging the runner
 * shell's uninstrumented lines into the coverage gate. */
export const junitPathForRun = async (junitPath?: string): Promise<string> => {
  if (junitPath !== undefined) return junitPath;
  const dir = await Deno.makeTempDir({ prefix: "test-junit-" });
  return join(dir, "junit.xml");
};
