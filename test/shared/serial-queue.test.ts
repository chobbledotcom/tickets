/** The queue every key rotation runs through: work lands in the order it was
 *  asked for, and one failure never stops the work behind it. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { serialQueue } from "#shared/serial-queue.ts";

test("runs queued jobs in the order they were asked for", async () => {
  const queue = serialQueue();
  const events: string[] = [];
  const first = queue(async () => {
    events.push("first starts");
    await Promise.resolve();
    events.push("first ends");
    return "first";
  });
  const second = queue(() => {
    events.push("second starts");
    return Promise.resolve("second");
  });

  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  // The second body must not begin before the first one finished, or two
  // overlapping key changes could land out of order.
  expect(events).toEqual(["first starts", "first ends", "second starts"]);
});

test("keeps running the queue after a job fails", async () => {
  const queue = serialQueue();
  const failure = queue(() => Promise.reject(new Error("refused")));
  const after = queue(() => Promise.resolve("after"));

  await expect(failure).rejects.toThrow("refused");
  expect(await after).toBe("after");
});
