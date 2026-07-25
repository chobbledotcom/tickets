import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { precommitLockPath } from "#scripts/precommit/lock.ts";

describe("precommitLockPath", () => {
  test("gives each user a separate lock file", () => {
    const directory = "/tmp";

    expect(precommitLockPath(directory, 1000)).toBe(
      join(directory, "chobble-tickets-precommit-1000.lock"),
    );
    expect(precommitLockPath(directory, 1001)).toBe(
      join(directory, "chobble-tickets-precommit-1001.lock"),
    );
  });
});
