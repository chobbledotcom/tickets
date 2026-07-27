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
const closeDown = async (
  child: Deno.ChildProcess,
): Promise<Deno.CommandStatus> => {
  await child.stdin.close();
  return await child.status;
};

/**
 * Hold the lock at `path` through a child process. `null` means the lock did
 * not come free within `timeoutMs`, or its folder is not there to lock in. A
 * lock that could not be taken at all throws instead: that is not "busy".
 */
export const holdLockOrNull = async (
  path: string,
  timeoutMs: number,
): Promise<HeldLock | null> => {
  // No folder to make the lock file in means nobody's lock to take.
  if ((await statOrNull(dirname(path))) === null) return null;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", HOLD_LOCK_SCRIPT, "--", path, String(timeoutMs)],
    stderr: "piped",
    stdin: "piped",
    stdout: "piped",
  }).spawn();

  const reader = child.stdout.getReader();
  const line = await heldLine(reader);
  reader.releaseLock();
  await child.stdout.cancel();

  if (line === null) {
    // It ends quietly when its own time runs out. Ending any other way means
    // the lock could not be taken at all, which is not the same as busy.
    const why = await new Response(child.stderr).text();
    const stopped = await closeDown(child);
    // Its folder can go while it is starting, which is nobody's lock rather
    // than a failure to take one.
    const folderWent = (await statOrNull(dirname(path))) === null;
    if (!(stopped.success || folderWent)) {
      throw new Error(`Could not take the lock at ${path}: ${why.trim()}`);
    }
    return null;
  }
  await child.stderr.cancel();
  return {
    fileNumber: Number(line.split(" ")[1]),
    letGo: async () => {
      await closeDown(child);
    },
  };
};
