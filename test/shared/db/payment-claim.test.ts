import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import {
  claimAttendeeRows,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

const protectedStateOf = (sessionId: string): Promise<{ v: string } | null> =>
  queryOne<{ v: string }>(
    "SELECT protected_state AS v FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

const referenceIndexOf = (sessionId: string): Promise<{ v: string } | null> =>
  queryOne<{ v: string }>(
    "SELECT payment_reference_index AS v FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

describeWithEnv("db > payment claim", { db: true, encryptionKey: true }, () => {
  /** One attendee holding one finalized payment row for `reference`. */
  const bookedWith = async (
    sessionId: string,
    reference: string,
  ): Promise<number> => {
    const listing = await createTestListing();
    const booked = await bookAttendee(listing, {
      email: "buyer@example.com",
      name: "Buyer",
    });
    if (!booked.success) throw new Error("Failed to create the attendee");
    const attendeeId = booked.attendees[0]!.id;
    await finalizeProcessedPayment(sessionId, attendeeId, "tok", reference);
    return attendeeId;
  };

  describe("claiming", () => {
    test("an unclaimed attendee's rows are claimed", async () => {
      const attendeeId = await bookedWith("sess-a", "pi_a");
      const result = await claimAttendeeRows(attendeeId, "keyless");
      expect(result).toEqual({ kind: "claimed", sessionIds: ["sess-a"] });
    });

    test("the claim shows in the plaintext mirror the prune reads", async () => {
      const attendeeId = await bookedWith("sess-b", "pi_b");
      await claimAttendeeRows(attendeeId, "keyless");
      expect(await protectedStateOf("sess-b")).toEqual({ v: "claim" });
    });

    test("a second run on the same attendee is told the work is in progress", async () => {
      const attendeeId = await bookedWith("sess-c", "pi_c");
      await claimAttendeeRows(attendeeId, "keyless");
      expect(await claimAttendeeRows(attendeeId, "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("two concurrent runs on one attendee: exactly one wins", async () => {
      const attendeeId = await bookedWith("sess-d", "pi_d");
      const results = await Promise.all([
        claimAttendeeRows(attendeeId, "keyless"),
        claimAttendeeRows(attendeeId, "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "blocked")).toHaveLength(1);
    });

    test("two attendees sharing one reference: only one may hold the money", async () => {
      const first = await bookedWith("sess-e1", "pi_shared");
      const second = await bookedWith("sess-e2", "pi_shared");

      expect(await claimAttendeeRows(first, "keyless")).toEqual({
        kind: "claimed",
        sessionIds: ["sess-e1"],
      });
      // The second attendee's own row is untouched, but the money behind it is
      // already claimed, so this run must not reach the provider.
      expect(await claimAttendeeRows(second, "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("two attendees sharing one reference, claimed concurrently: one wins", async () => {
      const first = await bookedWith("sess-f1", "pi_race");
      const second = await bookedWith("sess-f2", "pi_race");
      const results = await Promise.all([
        claimAttendeeRows(first, "keyless"),
        claimAttendeeRows(second, "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    });

    test("a claim on one attendee leaves an unrelated attendee free", async () => {
      const first = await bookedWith("sess-g1", "pi_g1");
      const second = await bookedWith("sess-g2", "pi_g2");
      await claimAttendeeRows(first, "keyless");
      expect(await claimAttendeeRows(second, "keyless")).toEqual({
        kind: "claimed",
        sessionIds: ["sess-g2"],
      });
    });
  });

  describe("the reference index", () => {
    test("is written by the same statement as the reference", async () => {
      await bookedWith("sess-h", "pi_h");
      const stored = await referenceIndexOf("sess-h");
      expect(stored?.v).toMatch(/^.+$/);
    });

    test("is the same for the same reference on two rows", async () => {
      await bookedWith("sess-i1", "pi_same");
      await bookedWith("sess-i2", "pi_same");
      expect(await referenceIndexOf("sess-i1")).toEqual(
        await referenceIndexOf("sess-i2"),
      );
    });

    test("differs for different references", async () => {
      await bookedWith("sess-j1", "pi_one");
      await bookedWith("sess-j2", "pi_two");
      expect(await referenceIndexOf("sess-j1")).not.toEqual(
        await referenceIndexOf("sess-j2"),
      );
    });

    test("never stores the reference itself", async () => {
      await bookedWith("sess-k", "pi_secret");
      expect((await referenceIndexOf("sess-k"))?.v).not.toContain("pi_secret");
    });
  });

  describe("releasing", () => {
    test("a released row can be claimed again", async () => {
      const attendeeId = await bookedWith("sess-l", "pi_l");
      const claimed = await claimAttendeeRows(attendeeId, "keyless");
      expect(claimed.kind).toBe("claimed");
      await releaseAttendeeRows(["sess-l"]);
      expect(await claimAttendeeRows(attendeeId, "keyless")).toEqual({
        kind: "claimed",
        sessionIds: ["sess-l"],
      });
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWith("sess-m", "pi_m");
      await claimAttendeeRows(attendeeId, "keyless");
      await releaseAttendeeRows(["sess-m"]);
      expect(await protectedStateOf("sess-m")).toEqual({ v: "" });
    });

    test("releasing nothing touches nothing", async () => {
      await releaseAttendeeRows([]);
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWith("sess-n", "pi_n");
      await releaseAttendeeRows(["sess-n"]);
      expect(await protectedStateOf("sess-n")).toEqual({ v: "" });
    });
  });
});
