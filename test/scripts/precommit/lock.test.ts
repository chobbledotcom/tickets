import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { precommitLockAt, precommitLockPath } from "#scripts/precommit/lock.ts";

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
      precommitLockAt(LOCK_PATH)(() => Promise.resolve("checked")),
    ).resolves.toBe("checked");
  });
});
