import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withEnvironment } from "#scripts/test-environment.ts";

/** Names nothing else in the suite reads or writes. `Deno.env` belongs to the
 * whole process, and test files run side by side in it, so borrowing a real
 * setting's name here would let this test and a neighbour clobber each other. */
const EMPTY = "TICKETS_TEST_ENVIRONMENT_EMPTY";
const MISSING = "TICKETS_TEST_ENVIRONMENT_MISSING";

describe("temporary environment", () => {
  test("restores empty and missing values exactly", async () => {
    Deno.env.set(EMPTY, "");
    Deno.env.delete(MISSING);
    try {
      await expect(
        withEnvironment({ [EMPTY]: "localhost", [MISSING]: "43210" }, () => {
          expect(Deno.env.get(EMPTY)).toBe("localhost");
          expect(Deno.env.get(MISSING)).toBe("43210");
          throw new Error("Task failed");
        }),
      ).rejects.toThrow("Task failed");

      expect(Deno.env.get(EMPTY)).toBe("");
      expect(Deno.env.get(MISSING)).toBeUndefined();
    } finally {
      Deno.env.delete(EMPTY);
      Deno.env.delete(MISSING);
    }
  });

  test("returns the task result before restoring existing values", async () => {
    Deno.env.set(EMPTY, "before");
    try {
      const result = await withEnvironment({ [EMPTY]: "during" }, () =>
        Promise.resolve(Deno.env.get(EMPTY)),
      );
      expect(result).toBe("during");
      expect(Deno.env.get(EMPTY)).toBe("before");
    } finally {
      Deno.env.delete(EMPTY);
    }
  });
});
