import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withEnvironment } from "#scripts/test-environment.ts";

const HOST = "STRIPE_MOCK_HOST";
const PORT = "STRIPE_MOCK_PORT";

describe("temporary environment", () => {
  test("restores empty and missing values exactly", async () => {
    const originalHost = Deno.env.get(HOST);
    const originalPort = Deno.env.get(PORT);
    Deno.env.set(HOST, "");
    Deno.env.delete(PORT);
    try {
      await expect(
        withEnvironment({ [HOST]: "localhost", [PORT]: "43210" }, async () => {
          expect(Deno.env.get(HOST)).toBe("localhost");
          expect(Deno.env.get(PORT)).toBe("43210");
          throw new Error("Task failed");
        }),
      ).rejects.toThrow("Task failed");

      expect(Deno.env.get(HOST)).toBe("");
      expect(Deno.env.get(PORT)).toBeUndefined();
    } finally {
      if (originalHost === undefined) Deno.env.delete(HOST);
      else Deno.env.set(HOST, originalHost);
      if (originalPort === undefined) Deno.env.delete(PORT);
      else Deno.env.set(PORT, originalPort);
    }
  });

  test("returns the task result before restoring existing values", async () => {
    const original = Deno.env.get(PORT);
    Deno.env.set(PORT, "before");
    try {
      const result = await withEnvironment({ [PORT]: "during" }, () =>
        Promise.resolve(Deno.env.get(PORT)),
      );
      expect(result).toBe("during");
      expect(Deno.env.get(PORT)).toBe("before");
    } finally {
      if (original === undefined) Deno.env.delete(PORT);
      else Deno.env.set(PORT, original);
    }
  });
});
