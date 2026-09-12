import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingEventGroup,
  mapBooking,
  refundEventGroup,
} from "#accounting/mappers.ts";
import { eventGroup, legReference, type RefPart } from "#accounting/refs.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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

  describe("unsafe numeric parts", () => {
    const rejectionMessage = async (parts: RefPart[]): Promise<string> => {
      try {
        await eventGroup(parts);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };

    test("rejects a non-finite part rather than hashing an ambiguous null", async () => {
      expect(await rejectionMessage(["booking", Number.NaN])).toContain(
        "safe integer",
      );
    });

    test("rejects an integer past MAX_SAFE_INTEGER that would round and collide", async () => {
      // 2 ** 53 and 2 ** 53 + 1 round to the same float, so hashing them raw
      // would alias two distinct ids onto one reference.
      expect(await rejectionMessage(["booking", 2 ** 53])).toContain(
        "safe integer",
      );
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

  describe("the persisted domain words", () => {
    // These derivations are persisted against: stored event groups and leg
    // references are recomputed by later code (replay lookups, the
    // reverses-group backfill). Changing a domain word changes every new key
    // while historical rows keep the old one, so the words are part of the
    // storage format and are pinned here against their spelled tuples.
    test("bookingEventGroup derives from the spelled booking domain", async () => {
      expect(await bookingEventGroup("session-7")).toBe(
        await eventGroup(["booking", "session-7"]),
      );
    });

    test("refundEventGroup derives from the spelled refund domain", async () => {
      const booking = await eventGroup(["booking", "session-7"]);
      expect(await refundEventGroup(booking)).toBe(
        await eventGroup(["refund", booking]),
      );
    });

    test("a modifier leg's reference derives from the spelled tuple", async () => {
      const [modifierLeg] = await mapBooking({
        amountPaid: 0,
        attendeeId: 3,
        bookingFee: 0,
        eventId: "mod-pin",
        lines: [],
        modifiers: [{ delta: -250, modifierId: 7 }],
        occurredAt: "2026-06-21T00:00:00.000Z",
      });
      expect(modifierLeg).toBeDefined();
      expect(modifierLeg!.reference).toBe(
        await legReference(["booking", "mod-pin", "mod", 7]),
      );
    });
  });
});
