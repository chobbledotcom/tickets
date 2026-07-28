import { join } from "node:path";
import { stub } from "@std/testing/mock";
import { runIsolatedMutationCommand } from "#scripts/mutation/isolation.ts";
import {
  markFinished,
  newRunRecord,
  recordPath,
  runRoot,
} from "#scripts/mutation/isolation-state.ts";
import { withTempDir as withSharedTempDir } from "#test-utils/files.ts";

export const withTempDir = <Result>(
  run: (dir: string) => Promise<Result>,
): Promise<Result> => withSharedTempDir(run, { prefix: "mutation-isolation-" });

/** A time far enough back that the startup grace no longer covers it. */
export const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

const lineFrom = (values: unknown[]): string => values.map(String).join(" ");

export const captureConsole = async <Result>(
  run: () => Promise<Result>,
): Promise<{ errors: string[]; logs: string[]; result: Result }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  using _log = stub(console, "log", (...values: unknown[]) => {
    logs.push(lineFrom(values));
  });
  using _error = stub(console, "error", (...values: unknown[]) => {
    errors.push(lineFrom(values));
  });

  return { errors, logs, result: await run() };
};

export const captureMutationCommand = async (
  args: string[],
  root: string,
): Promise<{ errors: string[]; logs: string[]; result: number }> =>
  await captureConsole(() => runIsolatedMutationCommand(args, root));

export const runQuietMutationCommand = async (
  args: string[],
  root: string,
): Promise<number> => (await captureMutationCommand(args, root)).result;

export const writeMovedRunRecord = async (
  root: string,
): Promise<{
  id: string;
  oldRunRoot: string;
  record: ReturnType<typeof markFinished>;
}> => {
  const id = "mutation-moved";
  const oldRunRoot = join(root, "old-checkout", ".mutation-runs", id);
  const record = markFinished(newRunRecord(id, [], root), 0);
  await Deno.mkdir(runRoot(id, root), { recursive: true });
  await Deno.writeTextFile(
    recordPath(id, root),
    `${JSON.stringify({
      ...record,
      root: oldRunRoot,
      workRoot: join(oldRunRoot, "work"),
    })}\n`,
  );
  return { id, oldRunRoot, record };
};

export const writeFakeScript = async (
  root: string,
  name: string,
  body: string,
): Promise<void> => {
  await Deno.mkdir(join(root, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(root, "scripts", name), body);
};

export const writeFakeMutationScript = (
  root: string,
  body: string,
): Promise<void> => writeFakeScript(root, "mutation.ts", body);

/**
 * Run `body` with coverage collection kept out of the child's environment. A
 * child that records coverage names files inside the copy, which is deleted
 * when the run ends, and the coverage report cannot then read them back.
 */
export const withoutChildCoverage = async <Result>(
  body: () => Promise<Result>,
): Promise<Result> => {
  const dir = Deno.env.get("DENO_COVERAGE_DIR");
  if (dir === undefined) return await body();
  Deno.env.delete("DENO_COVERAGE_DIR");
  try {
    return await body();
  } finally {
    Deno.env.set("DENO_COVERAGE_DIR", dir);
  }
};
