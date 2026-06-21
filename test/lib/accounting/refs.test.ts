import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("accounting > refs", { encryptionKey: true }, () => {
  describe("eventGroup", () => {
    test("is deterministic for the same parts", async () => {
      expect(await eventGroup(["booking", "abc"])).toBe(
        await eventGroup(["booking", "abc"]),
      );
    });

    test("differs for different parts", async () => {
      expect(await eventGroup(["booking", "abc"])).not.toBe(
        await eventGroup(["booking", "xyz"]),
      );
    });

    test("does not collide across different tuple shapes", async () => {
      // A `|`-joined encoding would collapse each of these pairs onto one key;
      // JSON encoding keeps them distinct.
      expect(await eventGroup(["booking", "a|b"])).not.toBe(
        await eventGroup(["booking", "a", "b"]),
      );
      expect(await eventGroup(["a", "b"])).not.toBe(await eventGroup(["ab"]));
    });
  });

  describe("legReference", () => {
    test("is distinct from an event group built from the same parts", async () => {
      expect(await legReference(["booking", "abc"])).not.toBe(
        await eventGroup(["booking", "abc"]),
      );
    });

    test("distinguishes legs of the same event", async () => {
      const sale = await legReference(["booking", "abc", "sale", 1]);
      const payment = await legReference(["booking", "abc", "payment"]);
      expect(sale).not.toBe(payment);
    });

    test("is non-empty and reveals nothing about its input", async () => {
      const ref = await legReference(["booking", "secret-payment-id"]);
      expect(ref.length).toBeGreaterThan(0);
      expect(ref).not.toContain("secret-payment-id");
    });
  });
});
