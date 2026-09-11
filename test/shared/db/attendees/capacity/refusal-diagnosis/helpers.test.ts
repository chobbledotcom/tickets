import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { enableQueryLog, runWithQueryLogContext } from "#db/query-log.ts";
import { awaitObservedProbe } from "./helpers.ts";

test("awaitObservedProbe fails loudly when no probe statement lands", async () => {
  await runWithQueryLogContext(async () => {
    enableQueryLog();
    // A zero deadline ends the wait on the spot, so the test proves the loud
    // failure without paying the real five-second timeout.
    await expect(awaitObservedProbe(0)).rejects.toThrow(
      "Setup: the probe batch was never observed",
    );
  });
});
