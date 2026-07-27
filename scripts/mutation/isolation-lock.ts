/**
 * The lock each mutation run holds while it owns its folder.
 */

import { join } from "@std/path";
import { openLockFile, withFileLock } from "#scripts/lock-file.ts";
import { nullIfNotFound, statOrNull } from "#scripts/not-found.ts";
import { denoExitCode } from "./child-process.ts";
import {
  MUTATION_RUN_LOCK_FILE,
  type MutationRunRecord,
  runLockPath,
} from "./isolation-state.ts";

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

const lockProbeExitCode = (path: string, timeoutMs: number): Promise<number> =>
  denoExitCode(["eval", LOCK_PROBE_SCRIPT, "--", path, String(timeoutMs)], {
    stderr: "null",
    stdout: "null",
  });

export const runLockIsHeld = async (
  record: Pick<MutationRunRecord, "root">,
  timeoutMs = 50,
): Promise<boolean> => {
  const path = runLockPath(record);
  const file = await openLockFile(path).catch(() => null);
  if (file === null) return false;
  file.close();
  return (await lockProbeExitCode(path, timeoutMs)) === LOCK_HELD_EXIT_CODE;
};

/** Is the open lock file still the one sitting at the run's lock path? */
const stillTheLockFile = async (
  file: Deno.FsFile,
  record: Pick<MutationRunRecord, "root">,
): Promise<boolean> => {
  const atPath = await statOrNull(runLockPath(record));
  if (atPath === null) return false;
  const held = await file.stat();
  // Some filesystems keep no inode numbers; there, take the file at its word.
  return held.ino === null || atPath.ino === null || held.ino === atPath.ino;
};

/**
 * Hold a run's lock while `run` works, but only if it is free within
 * `timeoutMs`; otherwise give up and answer `null`. Clearing up must never
 * queue behind a run that holds its folder for an hour.
 */
export const withRunLockOrNull = async <Result>(
  record: Pick<MutationRunRecord, "root">,
  run: () => Promise<Result>,
  timeoutMs = 250,
): Promise<Result | null> => {
  // A folder that has gone is nobody's to take: another clear-up got there
  // first. Any other failure to open means a disk we must not guess about.
  const file = await nullIfNotFound(openLockFile(runLockPath(record)));
  if (file === null) return null;
  const locked = file.lock(true).then(() => true);
  let waited = 0;
  const gaveUp = new Promise<false>((resolve) => {
    waited = setTimeout(() => resolve(false), timeoutMs);
    Deno.unrefTimer(waited);
  });
  if (!(await Promise.race([locked, gaveUp]))) {
    // Closing hands back anything the abandoned wait is later granted.
    file.close();
    return null;
  }
  clearTimeout(waited);
  try {
    // The wait may have been won only because somebody deleted the folder: the
    // open file lives on with nothing pointing at it, so a lock on it now keeps
    // nobody out. Only the file still sitting at the path is worth holding.
    return (await stillTheLockFile(file, record)) ? await run() : null;
  } finally {
    await file.unlock();
    file.close();
  }
};

/** Hold a run's own lock, making its folder first so there is one to lock. */
export const withMutationRunLock = async <Result>(
  runRootPath: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  await Deno.mkdir(runRootPath, { recursive: true });
  return await withFileLock(join(runRootPath, MUTATION_RUN_LOCK_FILE), run);
};
