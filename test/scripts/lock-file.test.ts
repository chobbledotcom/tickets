import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { withFileLock } from "#scripts/lock-file.ts";

const LOCK_PATH = join(
  Deno.env.get("TMPDIR") ?? "/tmp",
  `chobble-tickets-file-lock-test-${Deno.pid}-${Date.now()}.lock`,
);

const HOLD_LOCK_SCRIPT = `
const file = await Deno.open(Deno.args[0], {
  create: true,
  read: true,
  write: true,
});
await file.lock();
await Deno.stdout.write(new TextEncoder().encode("locked\\n"));
await Deno.stdin.read(new Uint8Array(1));
file.close();
`;

const EXIT_WITH_LOCK_SCRIPT = `
const file = await Deno.open(Deno.args[0], {
  create: true,
  read: true,
  write: true,
});
await file.lock();
await Deno.stdout.write(new TextEncoder().encode("locked\\n"));
Deno.exit(0);
`;

const startHolder = (
  script: string,
  stdin: "piped" | "null" = "piped",
): Deno.ChildProcess =>
  new Deno.Command(Deno.execPath(), {
    args: ["eval", script, "--", LOCK_PATH],
    stdin,
    stdout: "piped",
  }).spawn();

const waitUntilLocked = async (child: Deno.ChildProcess): Promise<void> => {
  const reader = child.stdout.getReader();
  try {
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("locked\n");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

const releaseHolder = async (child: Deno.ChildProcess): Promise<void> => {
  const writer = child.stdin.getWriter();
  await writer.write(new Uint8Array([1]));
  await writer.close();
  await child.status;
};

const stubOpenedFile = (change: (file: Deno.FsFile) => void) => {
  const open = Deno.open;
  return stub(
    Deno,
    "open",
    async (
      path: string | URL,
      options?: Deno.OpenOptions,
    ): Promise<Deno.FsFile> => {
      const file = await open(path, options);
      change(file);
      return file;
    },
  );
};

describe("withFileLock", () => {
  beforeEach(() => removeIfPresent(LOCK_PATH));
  afterEach(() => removeIfPresent(LOCK_PATH));

  test("runs the task and returns its value", async () => {
    await expect(
      withFileLock(LOCK_PATH, () => Promise.resolve("checked")),
    ).resolves.toBe("checked");
  });

  test("waits for a lock held by another process", async () => {
    const holder = startHolder(HOLD_LOCK_SCRIPT);
    await waitUntilLocked(holder);

    const lockAttempted = Promise.withResolvers<void>();
    const openStub = stubOpenedFile((file) => {
      const lock = file.lock.bind(file);
      file.lock = (exclusive?: boolean): Promise<void> => {
        lockAttempted.resolve();
        return lock(exclusive);
      };
    });

    let ran = false;
    let waiting: Promise<void> = Promise.resolve();
    try {
      waiting = withFileLock(LOCK_PATH, async () => {
        ran = true;
      });
      await lockAttempted.promise;
      expect(ran).toBe(false);
    } finally {
      openStub.restore();
      await releaseHolder(holder);
    }

    await waiting;
    expect(ran).toBe(true);
  });

  test("waits for unlock before closing and returning", async () => {
    const unlockStarted = Promise.withResolvers<void>();
    const releaseUnlock = Promise.withResolvers<void>();
    let closed = false;
    const openStub = stubOpenedFile((file) => {
      const close = file.close.bind(file);
      file.unlock = () => {
        unlockStarted.resolve();
        return releaseUnlock.promise;
      };
      file.close = () => {
        closed = true;
        close();
      };
    });

    let settled = false;
    const result = withFileLock(LOCK_PATH, () =>
      Promise.resolve("checked"),
    ).finally(() => {
      settled = true;
    });

    try {
      await unlockStarted.promise;
      expect(settled).toBe(false);
      expect(closed).toBe(false);
    } finally {
      releaseUnlock.resolve();
      await result;
      openStub.restore();
    }

    expect(closed).toBe(true);
    await expect(result).resolves.toBe("checked");
  });

  test("acquires after a holder exits without unlocking", async () => {
    const holder = startHolder(EXIT_WITH_LOCK_SCRIPT, "null");
    await waitUntilLocked(holder);
    await holder.status;

    await expect(
      withFileLock(LOCK_PATH, () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
  });
});
