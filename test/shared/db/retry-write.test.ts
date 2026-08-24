import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { retryWrite } from "#db/retry-write.ts";

test("retryWrite returns the first revision-fenced write that succeeds", async () => {
  let attempts = 0;
  const result = await retryWrite("failed", () => {
    attempts += 1;
    return Promise.resolve(attempts === 3 ? { value: "saved" } : null);
  });

  expect(result).toBe("saved");
  expect(attempts).toBe(3);
});

test("retryWrite fails after four lost races", async () => {
  let attempts = 0;
  await expect(
    retryWrite("Could not save", () => {
      attempts += 1;
      return Promise.resolve(null);
    }),
  ).rejects.toThrow("Could not save");
  expect(attempts).toBe(4);
});
