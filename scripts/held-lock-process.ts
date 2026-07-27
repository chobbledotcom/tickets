/**
 * A lock held for us by a child process, so that giving up on the wait really
 * does give up.
 *
 * Waiting for a lock in this process cannot be called off: the wait keeps the
 * process alive until the lock arrives, however long that takes, and closing
 * the file does not stop it. A command that gave up after a quarter of a second
 * would still sit there until the other job finished. So the waiting is done by
 * a child we can stop instead.
 */

import { dirname } from "@std/path";
import { statOrNull } from "#scripts/not-found.ts";

/**
 * Says it is about to wait, takes the lock, says which file it got, and holds
 * it until its input closes — when we let go, or if we die first.
 */
const HOLD_LOCK_SCRIPT = `
const say = (line) => Deno.stdout.write(new TextEncoder().encode(line + "\\n"));
const file = await Deno.open(Deno.args[0], { create: true, read: true, write: true });
await say("waiting");
await file.lock(true);
const { ino } = await file.stat();
await say(\`held \${ino ?? ""}\`);
await Deno.stdin.read(new Uint8Array(1));
await file.unlock();
file.close();
`;

export interface HeldLock {
  /** The file number of the lock it took, or `null` if the disk keeps none. */
  fileNumber: number | null;
  letGo: () => Promise<void>;
}

/**
 * The child's `held` line, or `null` if it stops before saying one. Calls
 * `nowWaiting` as soon as the child is up and queueing for the lock.
 */
const heldLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  nowWaiting: () => void,
): Promise<string | null> => {
  let said = "";
  for (;;) {
    const { value } = await reader.read();
    if (value === undefined) return null;
    said += new TextDecoder().decode(value);
    if (said.includes("waiting\n")) nowWaiting();
    const held = said.split("\n").find((line) => line.startsWith("held"));
    if (held !== undefined) return held;
  }
};

/** The file number in a `held <number>` line, or `null` if it carries none. */
const fileNumberIn = (line: string): number | null => {
  const [, number] = line.split(" ");
  return number === undefined || number === "" ? null : Number(number);
};

/** Wait for the child to stop, leaving none of its pipes open behind us. */
const closeDown = async (child: Deno.ChildProcess): Promise<void> => {
  await child.stdin.close();
  await child.status;
};

const stopWaiting = async (child: Deno.ChildProcess): Promise<void> => {
  try {
    child.kill();
  } catch (error) {
    // Deno throws a TypeError for a child that has already stopped, which is
    // an ordinary way for this to end: its folder can go while it waits.
    if (!(error instanceof TypeError)) throw error;
  }
  await closeDown(child);
};

/**
 * Hold the lock at `path` through a child process. `null` means the lock did
 * not come free within `timeoutMs`, or its folder is not there to lock in.
 */
export const holdLockOrNull = async (
  path: string,
  timeoutMs: number,
): Promise<HeldLock | null> => {
  // No folder to make the lock file in means nobody's lock to take.
  if ((await statOrNull(dirname(path))) === null) return null;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", HOLD_LOCK_SCRIPT, "--", path],
    stderr: "null",
    stdin: "piped",
    stdout: "piped",
  }).spawn();

  // The clock starts when the child is up and queueing, not when it is asked
  // to start: how long we are prepared to wait is about the lock, not about
  // how busy the machine is with starting processes.
  const nowWaiting = Promise.withResolvers<void>();
  let waited = 0;
  const gaveUp = nowWaiting.promise.then(
    () =>
      new Promise<null>((resolve) => {
        waited = setTimeout(() => resolve(null), timeoutMs);
        Deno.unrefTimer(waited);
      }),
  );
  const reader = child.stdout.getReader();
  const line = await Promise.race([
    heldLine(reader, nowWaiting.resolve),
    gaveUp,
  ]);
  clearTimeout(waited);
  // Cancelling ends the read the timeout walked away from, so the child's
  // output is closed either way and nothing is left holding it.
  await reader.cancel();
  reader.releaseLock();

  if (line === null || !line.startsWith("held")) {
    await stopWaiting(child);
    return null;
  }
  return {
    fileNumber: fileNumberIn(line),
    letGo: () => closeDown(child),
  };
};
