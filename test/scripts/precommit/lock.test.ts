import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { withLockAt } from "#scripts/lock-file.ts";
import {
  precommitLockPath,
  withPrecommitLock,
} from "#scripts/precommit/lock.ts";
import { tempDir } from "#test-utils/files.ts";

const LOCK_PATH = join(
  Deno.env.get("TMPDIR") ?? "/tmp",
  `chobble-tickets-precommit-lock-test-${Deno.pid}-${Date.now()}.lock`,
);

describe("precommit lock", () => {
  afterEach(() => removeIfPresent(LOCK_PATH));

  test("gives each user a separate lock file", () => {
    const directory = "/tmp";

    expect(precommitLockPath(directory, 1000)).toBe(
      join(directory, "chobble-tickets-precommit-1000.lock"),
    );
    expect(precommitLockPath(directory, 1001)).toBe(
      join(directory, "chobble-tickets-precommit-1001.lock"),
    );
  });

  test("runs a task with the configured lock file", async () => {
    await expect(
      withLockAt(LOCK_PATH)(() => Promise.resolve("checked")),
    ).resolves.toBe("checked");
  });

  test("runs a task under this user's lock", async () => {
    using dir = tempDir();
    using _env = stub(Deno.env, "get", (key: string) =>
      key === "TMPDIR" ? dir.path : undefined,
    );

    await expect(
      withPrecommitLock(() => Promise.resolve("checked")),
    ).resolves.toBe("checked");
  });

  test("falls back to the system temporary folder", async () => {
    using _env = stub(Deno.env, "get", () => undefined);

    await expect(
      withPrecommitLock(() => Promise.resolve("checked")),
    ).resolves.toBe("checked");
  });

  test("names the platform that cannot give the lock a user id", async () => {
    using _uid = stub(Deno, "uid", () => null);

    await expect(
      withPrecommitLock(() => Promise.resolve("checked")),
    ).rejects.toThrow(
      "The precommit lock needs a numeric user id, which this platform does not provide",
    );
  });
});
