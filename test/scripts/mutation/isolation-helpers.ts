import { join } from "node:path";
import { stub } from "@std/testing/mock";
import { runIsolatedMutationCommand } from "#scripts/mutation/isolation.ts";
import {
  type MutationRunRecord,
  markFinished,
  markRunning,
  newRunRecord,
  recordPath,
  runClaimPath,
  runRoot,
} from "#scripts/mutation/isolation-state.ts";
import { withTempDir as withSharedTempDir } from "#test-utils/files.ts";

export const withTempDir = <Result>(
  run: (dir: string) => Promise<Result>,
): Promise<Result> => withSharedTempDir(run, { prefix: "mutation-isolation-" });

/**
 * A run id of the shape `createRunId` really makes, named after what the test
 * is doing with it. The runner only ever touches folders whose names match that
 * shape, so a fixture called "live" or "stale" would be skipped entirely; the
 * label is folded into the id's hex tail instead, so a failure still points at
 * the run the test meant rather than a bare timestamp.
 */
export const runIdNamed = (label: string): string => {
  let mixed = 0;
  for (const letter of label) mixed = (mixed * 31 + letter.charCodeAt(0)) >>> 0;
  return `mutation-20260709T123456Z-${mixed.toString(16).padStart(8, "0")}`;
};

/** A run that says it is going, under the pid given. */
export const runningRun = (
  label: string,
  root: string,
  pid: number,
): ReturnType<typeof markRunning> =>
  markRunning(newRunRecord(runIdNamed(label), [], root), pid);

/** A run that says it is going but never wrote down a pid, so nothing can be
 * asked about whether it really is. */
export const runningWithoutPid = (
  label: string,
  root: string,
): ReturnType<typeof newRunRecord> & { status: "running" } => ({
  ...newRunRecord(runIdNamed(label), [], root),
  status: "running" as const,
});

/** A run that finished and came to nothing bad. */
export const finishedRun = (
  label: string,
  root: string,
): ReturnType<typeof markFinished> =>
  markFinished(newRunRecord(runIdNamed(label), [], root), 0);

/** A time far enough back that no claim written then is still fresh. */
export const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

/**
 * A claim as another run's supervisor would leave it on disk. Written at
 * `writtenAt`, so a moment ago means a live supervisor and `LONG_AGO` means
 * one that walked away.
 */
export const writeRunClaim = async (
  record: Pick<MutationRunRecord, "root">,
  writtenAt = Date.now(),
): Promise<void> => {
  await Deno.mkdir(record.root, { recursive: true });
  await Deno.writeTextFile(
    runClaimPath(record),
    `another-supervisor\n${writtenAt}`,
  );
};

export const removeRunClaim = (
  record: Pick<MutationRunRecord, "root">,
): Promise<void> => Deno.remove(runClaimPath(record));

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
  const id = runIdNamed("moved");
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
