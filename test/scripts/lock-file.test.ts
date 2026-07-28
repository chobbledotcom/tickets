import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { withFileLock, withFileLockOrNull } from "#scripts/lock-file.ts";
import { withTempDir } from "#test-utils/files.ts";

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
await file.lock(true);
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
await file.lock(true);
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

  test("creates the lock file when it is not there yet", async () => {
    await withFileLock(LOCK_PATH, () => Promise.resolve());

    expect((await Deno.stat(LOCK_PATH)).isFile).toBe(true);
  });

  test("keeps two holders in this process from overlapping", async () => {
    const order: string[] = [];
    const firstInside = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondAsked = Promise.withResolvers<void>();

    let opened = 0;
    const openStub = stubOpenedFile((file) => {
      opened++;
      if (opened < 2) return;
      const lock = file.lock.bind(file);
      file.lock = (exclusive?: boolean): Promise<void> => {
        const held = lock(exclusive);
        secondAsked.resolve();
        return held;
      };
    });

    try {
      const first = withFileLock(LOCK_PATH, async () => {
        order.push("first in");
        firstInside.resolve();
        await releaseFirst.promise;
        order.push("first out");
      });
      await firstInside.promise;

      const second = withFileLock(LOCK_PATH, () => {
        order.push("second in");
        return Promise.resolve();
      });

      // Wait for the second holder to actually ask for the lock, then give the
      // operating system time to hand it over. Both halves are needed: without
      // the signal the check could run before the request was even made, and
      // without the pause a shared lock would not yet have been granted, so a
      // lock that excludes nobody would still look like it was working.
      await secondAsked.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["first in"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);
    } finally {
      openStub.restore();
      releaseFirst.resolve();
    }

    expect(order).toEqual(["first in", "first out", "second in"]);
  });

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

describe("a lock that stops being the file at its path", () => {
  test("takes the lock again when the folder is swept mid-wait", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "swept", "one.lock");
      let checks = 0;
      const stat = Deno.stat;
      // The first lock taken reads as a file nothing points at, standing in for
      // a clear-up that removed the folder while this queued for it.
      using _stat = stub(Deno, "stat", (async (at: string | URL) => {
        checks += 1;
        const info = await stat(at);
        return checks === 1 ? { ...info, ino: (info.ino ?? 0) + 1 } : info;
      }) as typeof Deno.stat);

      expect(await withFileLock(path, () => Promise.resolve("ran"))).toBe(
        "ran",
      );
      // Once for the stale lock, once for the one it kept.
      expect(checks).toBe(2);
    });
  });

  test("takes the lock again when the folder goes before it opens", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "early", "one.lock");
      let opens = 0;
      const open = Deno.open;
      using _open = stub(Deno, "open", ((at: string | URL, options) => {
        if (!`${at}`.includes("early")) return open(at, options);
        opens += 1;
        return opens === 1
          ? Promise.reject(new Deno.errors.NotFound("swept"))
          : open(at, options);
      }) as typeof Deno.open);

      expect(await withFileLock(path, () => Promise.resolve("ran"))).toBe(
        "ran",
      );
      expect(opens).toBe(2);
    });
  });

  test("takes the lock again when the file at its path has gone", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      let looks = 0;
      const stat = Deno.stat;
      // The first look finds nothing at the path, as it would for a lock file
      // a clear-up deleted while this was waiting for it.
      using _stat = stub(Deno, "stat", ((at: string | URL) => {
        looks += 1;
        return looks === 1
          ? Promise.reject(new Deno.errors.NotFound("gone"))
          : stat(at);
      }) as typeof Deno.stat);

      expect(await withFileLock(path, () => Promise.resolve("ran"))).toBe(
        "ran",
      );
      expect(looks).toBe(2);
    });
  });

  test("holds a lock on a filesystem that keeps no file numbers", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      const stat = Deno.stat;
      using _stat = stub(Deno, "stat", (async (at: string | URL) => ({
        ...(await stat(at)),
        ino: null,
      })) as typeof Deno.stat);

      expect(await withFileLock(path, () => Promise.resolve("in"))).toBe("in");
    });
  });
});

describe("withFileLockOrNull", () => {
  test("takes a free lock and gives it back", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");

      expect(
        await withFileLockOrNull(path, 250, () => Promise.resolve("done")),
      ).toBe("done");
      // Free again, or this second take would wait for ever.
      expect(
        await withFileLockOrNull(path, 250, () => Promise.resolve("again")),
      ).toBe("again");
    });
  });

  test("gives up rather than queue behind whoever holds it", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      const release = Promise.withResolvers<void>();
      const holdingIt = Promise.withResolvers<void>();
      let ranInside = false;

      const holding = withFileLock(path, () => {
        holdingIt.resolve();
        return release.promise;
      });
      await holdingIt.promise;
      const gaveUp = await withFileLockOrNull(path, 30, () => {
        ranInside = true;
        return Promise.resolve("should not happen");
      });

      expect(gaveUp).toBeNull();
      expect(ranInside).toBe(false);

      release.resolve();
      await holding;
      // The lock it gave up on is handed back when it finally arrives, so the
      // path is free for the next holder.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        await withFileLockOrNull(path, 250, () => Promise.resolve("free")),
      ).toBe("free");
    });
  });

  test("leaves a folder that has already gone to whoever took it", async () => {
    await withTempDir(async (root) => {
      let ranInside = false;

      const answer = await withFileLockOrNull(
        join(root, "never-made", "one.lock"),
        250,
        () => {
          ranInside = true;
          return Promise.resolve("should not happen");
        },
      );

      expect(answer).toBeNull();
      expect(ranInside).toBe(false);
    });
  });

  test("gives up when the folder was deleted while it queued", async () => {
    await withTempDir(async (root) => {
      const folder = join(root, "doomed");
      const path = join(folder, "one.lock");
      const holdingIt = Promise.withResolvers<void>();
      const swept = Promise.withResolvers<void>();
      let ranInside = false;

      const holding = withFileLock(path, async () => {
        holdingIt.resolve();
        await swept.promise;
        await Deno.remove(folder, { recursive: true });
      });
      await holdingIt.promise;
      const waiting = withFileLockOrNull(path, 5_000, () => {
        ranInside = true;
        return Promise.resolve("should not happen");
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      swept.resolve();
      await holding;

      expect(await waiting).toBeNull();
      expect(ranInside).toBe(false);
    });
  });
});
