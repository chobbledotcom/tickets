import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runChecksBeforePush } from "#scripts/precommit/runner.ts";

describe("runChecksBeforePush", () => {
  test("releases the local lock before starting the push flow", async () => {
    const events: string[] = [];
    await runChecksBeforePush(
      false,
      () => {
        events.push("checks");
        return Promise.resolve();
      },
      () => {
        events.push("push");
        return Promise.resolve();
      },
      async (checks) => {
        events.push("lock acquired");
        await checks();
        events.push("lock released");
      },
    );

    expect(events).toEqual([
      "lock acquired",
      "checks",
      "lock released",
      "push",
    ]);
  });

  test("runs CI checks without taking the local lock", async () => {
    const events: string[] = [];
    await runChecksBeforePush(
      true,
      () => {
        events.push("checks");
        return Promise.resolve();
      },
      () => {
        events.push("push");
        return Promise.resolve();
      },
      () => {
        events.push("lock");
        return Promise.resolve();
      },
    );

    expect(events).toEqual(["checks", "push"]);
  });
});
