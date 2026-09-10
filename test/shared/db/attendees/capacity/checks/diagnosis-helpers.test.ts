import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { enableQueryLog, runWithQueryLogContext } from "#db/query-log.ts";
import { awaitObservedProbe } from "./diagnosis-helpers.ts";

test("awaitObservedProbe fails loudly when no probe statement lands", async () => {
  await runWithQueryLogContext(async () => {
    enableQueryLog();
    await expect(awaitObservedProbe()).rejects.toThrow(
      "Setup: the probe batch was never observed",
    );
  });
});
