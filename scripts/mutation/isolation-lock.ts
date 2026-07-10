/**
 * Run-lock probing and acquisition for isolated mutation runs.
 *
 * The child holds a `run.lock` file inside its run directory while alive.
 * Liveness checks probe whether that lock is held (without taking it
 * themselves) so list/kill/clean commands can distinguish a live run from a
 * stale record. The probe runs in a short-lived child process so a timed-out
 * probe does not leak a pending file-lock operation.
 */

import { join } from "@std/path";
import { MUTATION_RUN_LOCK_FILE } from "./isolation-state.ts";

const LOCK_HELD_EXIT_CODE = 124;

const LOCK_PROBE_SCRIPT = `
const [path, timeoutText] = Deno.args;
const timeout = setTimeout(
  () => Deno.exit(${LOCK_HELD_EXIT_CODE}),
  Number(timeoutText),
);
const file = await Deno.open(path, { read: true, write: true }).catch(() => null);
if (file === null) {
  clearTimeout(timeout);
  Deno.exit(2);
}
try {
  await file.lock(true);
  await file.unlock();
  clearTimeout(timeout);
  file.close();
  Deno.exit(0);
} catch {
  clearTimeout(timeout);
  file.close();
  Deno.exit(2);
}
`;

const lockProbeExitCode = async (
  path: string,
  timeoutMs: number,
): Promise<number> => {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["eval", LOCK_PROBE_SCRIPT, "--", path, String(timeoutMs)],
    stderr: "null",
    stdout: "null",
  }).output();
  return code;
};

export const runLockPath = (record: { root: string }): string =>
  join(record.root, MUTATION_RUN_LOCK_FILE);

export const runLockIsHeld = async (
  record: { root: string },
  timeoutMs = 50,
): Promise<boolean> => {
  const path = runLockPath(record);
  const file = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
  }).catch(() => null);
  if (file === null) return false;
  file.close();
  return (await lockProbeExitCode(path, timeoutMs)) === LOCK_HELD_EXIT_CODE;
};

export const withMutationRunLock = async <Result>(
  runRootPath: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  await Deno.mkdir(runRootPath, { recursive: true });
  const file = await Deno.open(join(runRootPath, MUTATION_RUN_LOCK_FILE), {
    create: true,
    read: true,
    write: true,
  });
  try {
    await file.lock(true);
    return await run();
  } finally {
    await file.unlock();
    file.close();
  }
};
