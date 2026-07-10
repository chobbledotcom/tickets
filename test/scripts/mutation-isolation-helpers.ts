import { join } from "node:path";
import { stub } from "@std/testing/mock";
import { runIsolatedMutationCommand } from "../../scripts/mutation/isolation.ts";
import {
  markFinished,
  newRunRecord,
  recordPath,
  runRoot,
} from "../../scripts/mutation/isolation-state.ts";

export const withTempDir = async (
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "mutation-isolation-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
};

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

export const writeFakeMutationScript = async (
  root: string,
  body: string,
): Promise<void> => {
  await Deno.mkdir(join(root, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(root, "scripts", "mutation.ts"), body);
};

export type DenoCommandShim = { Command: (...args: unknown[]) => unknown };
export const denoCommand = Deno as unknown as DenoCommandShim;
