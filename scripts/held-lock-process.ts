/**
 * A lock held for us by a child process, so that giving up on the wait really
 * does give up.
 *
 * Waiting for a lock in this process cannot be called off: the wait keeps the
 * process alive until the lock arrives, however long that takes, and closing
 * the file does not stop it. A command that gave up after a quarter of a second
 * would still sit there until the other job finished. So a child does the
 * waiting, and gives up by ending itself.
 */

import { dirname } from "@std/path";
import { statOrNull } from "#scripts/not-found.ts";

/**
 * Waits for the lock, says which file it got, and holds it until its input
 * closes — when we let go, or if we die first. It gives itself the same time
 * we would, counted from when it starts waiting, and ends if that runs out.
 */
const HOLD_LOCK_SCRIPT = `
const [path, timeoutText] = Deno.args;
const say = (line) => Deno.stdout.write(new TextEncoder().encode(line + "\\n"));
const file = await Deno.open(path, { create: true, read: true, write: true });
const gaveUp = setTimeout(() => Deno.exit(0), Number(timeoutText));
await file.lock(true);
clearTimeout(gaveUp);
const { ino } = await file.stat();
await say(\`held \${ino}\`);
await Deno.stdin.read(new Uint8Array(1));
await file.unlock();
file.close();
`;

export interface HeldLock {
  /** The file it locked, or `NaN` when the disk keeps no file numbers. */
  fileNumber: number;
  letGo: () => Promise<void>;
}

/** The child's `held` line, or `null` if it ends before saying one. */
const heldLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> => {
  let said = "";
  for (;;) {
    const { value } = await reader.read();
    if (value === undefined) return null;
    said += new TextDecoder().decode(value);
    const held = said.split("\n").find((line) => line.startsWith("held"));
    if (held !== undefined) return held;
  }
};

/** Wait for the child to stop, leaving none of its pipes open behind us. */
const closeDown = async (child: Deno.ChildProcess): Promise<void> => {
  await child.stdin.close();
  await child.status;
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
    args: ["eval", HOLD_LOCK_SCRIPT, "--", path, String(timeoutMs)],
    stderr: "null",
    stdin: "piped",
    stdout: "piped",
  }).spawn();

  const reader = child.stdout.getReader();
  const line = await heldLine(reader);
  reader.releaseLock();
  await child.stdout.cancel();

  if (line === null) {
    await closeDown(child);
    return null;
  }
  return {
    fileNumber: Number(line.split(" ")[1]),
    letGo: () => closeDown(child),
  };
};
