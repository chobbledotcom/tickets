import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  CLAIM_MIRROR,
  claimAttendeeRows,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { paymentReferenceIndex } from "#shared/db/payment-references.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { staleClaimSlot } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

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
      const result = await claimAttendeeRows([attendeeId], "keyless");
      expect(result.kind).toBe("claimed");
      expect(result).toMatchObject({ sessionIds: ["sess-a"] });
    });

    test("the claim shows in the plaintext mirror the prune reads", async () => {
      const attendeeId = await bookedWith("sess-b", "pi_b");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(held.heldSince).not.toBe("");
      // The prune cannot decrypt, so the mirror is all it has to go on: this
      // word is what keeps a claimed row from being deleted out from under a
      // refund that may already be on its way.
      expect(await protectedStateOf("sess-b")).toEqual({ v: CLAIM_MIRROR });
    });

    test("a second run on the same attendee is told the work is in progress", async () => {
      const attendeeId = await bookedWith("sess-c", "pi_c");
      await claimAttendeeRows([attendeeId], "keyless");
      expect(await claimAttendeeRows([attendeeId], "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("two concurrent runs on one attendee: exactly one wins", async () => {
      const attendeeId = await bookedWith("sess-d", "pi_d");
      const results = await Promise.all([
        claimAttendeeRows([attendeeId], "keyless"),
        claimAttendeeRows([attendeeId], "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "blocked")).toHaveLength(1);
    });

    test("two attendees sharing one reference: only one may hold the money", async () => {
      const first = await bookedWith("sess-e1", "pi_shared");
      const second = await bookedWith("sess-e2", "pi_shared");

      expect(await claimAttendeeRows([first], "keyless")).toMatchObject({
        kind: "claimed",
        sessionIds: ["sess-e1"],
      });
      // The second attendee's own row is untouched, but the money behind it is
      // already claimed by someone we cannot take over, so this run must not
      // reach the provider.
      expect(await claimAttendeeRows([second], "keyless")).toEqual({
        blockedBy: { kind: "foreign" },
        kind: "blocked",
      });
    });

    test("two attendees sharing one reference, claimed concurrently: one wins", async () => {
      const first = await bookedWith("sess-f1", "pi_race");
      const second = await bookedWith("sess-f2", "pi_race");
      const results = await Promise.all([
        claimAttendeeRows([first], "keyless"),
        claimAttendeeRows([second], "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    });

    test("a claim on one attendee leaves an unrelated attendee free", async () => {
      const first = await bookedWith("sess-g1", "pi_g1");
      const second = await bookedWith("sess-g2", "pi_g2");
      await claimAttendeeRows([first], "keyless");
      expect(await claimAttendeeRows([second], "keyless")).toMatchObject({
        kind: "claimed",
        sessionIds: ["sess-g2"],
      });
    });
  });

  describe("the reference index", () => {
    test("is written by the same statement as the reference", async () => {
      await bookedWith("sess-h", "pi_h");
      expect(await referenceIndexOf("sess-h")).toEqual({
        v: await paymentReferenceIndex("pi_h"),
      });
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
      const claimed = await claimAttendeeRows([attendeeId], "keyless");
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows(["sess-l"], claimed.heldSince);
      expect(await claimAttendeeRows([attendeeId], "keyless")).toMatchObject({
        kind: "claimed",
        sessionIds: ["sess-l"],
      });
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWith("sess-m", "pi_m");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows(["sess-m"], held.heldSince);
      expect(await protectedStateOf("sess-m")).toEqual({ v: "" });
    });

    test("releasing nothing reaches no database at all", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        await releaseAttendeeRows([], "2026-08-10T12:00:00.000Z");
      });
      expect(calls).toBe(0);
    });

    test("claiming nobody holds nothing and reaches no database", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        expect(await claimAttendeeRows([], "keyless")).toMatchObject({
          kind: "claimed",
          sessionIds: [],
        });
      });
      expect(calls).toBe(0);
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWith("sess-n", "pi_n");
      await releaseAttendeeRows(["sess-n"], "2026-08-10T12:00:00.000Z");
      expect(await protectedStateOf("sess-n")).toEqual({ v: "" });
    });
  });

  describe("a stalled run waking up", () => {
    test("does not strip the claim a later run now holds", async () => {
      const attendeeId = await bookedWith("sess-stall", "pi_stall");
      const stalled = await claimAttendeeRows([attendeeId], "keyless");
      if (stalled.kind !== "claimed") throw new Error("the claim was refused");

      // A later run resumed these rows and holds them now. The stalled run
      // waking up must not hand its successor's work to a third run.
      await releaseAttendeeRows(stalled.sessionIds, stalled.heldSince);
      const resumed = await claimAttendeeRows([attendeeId], "keyless");
      if (resumed.kind !== "claimed") throw new Error("the resume was refused");

      await releaseAttendeeRows(stalled.sessionIds, stalled.heldSince);

      expect(resumed.heldSince).not.toBe(stalled.heldSince);
      expect(await protectedStateOf("sess-stall")).toEqual({
        v: CLAIM_MIRROR,
      });
      expect(await claimAttendeeRows([attendeeId], "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });
  });
  describe("a shared reference someone else is holding", () => {
    test("blocks us even when their claim has gone stale", async () => {
      const other = await bookedWith("sess-p1", "pi_shared_stale");
      const ours = await bookedWith("sess-p2", "pi_shared_stale");
      const theirs = await claimAttendeeRows([other], "keyless");
      if (theirs.kind !== "claimed") throw new Error("the claim was refused");

      // Their claim is old enough to be a crashed worker, but it is on the
      // same money and we cannot take their row over — so we send nothing.
      await execute(
        "UPDATE processed_payments SET failure_data = ?, protected_state = '' WHERE payment_session_id = ?",
        [await staleClaimSlot(other), "sess-p1"],
      );

      expect(await claimAttendeeRows([ours], "keyless")).toEqual({
        blockedBy: { kind: "foreign" },
        kind: "blocked",
      });
    });
  });
  describe("what the claim reports about the money", () => {
    test("names a reference another run has already sent back", async () => {
      const attendeeId = await bookedWith("sess-q", "pi_already_back");
      await execute(
        "UPDATE processed_payments SET provider_refunded_at = ? WHERE payment_session_id = ?",
        [new Date(nowMs()).toISOString(), "sess-q"],
      );

      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      // A run holding this must not trust the reference list it loaded before
      // the hold — this is what tells it the money is already back.
      expect([...held.returned]).toEqual([
        await paymentReferenceIndex("pi_already_back"),
      ]);
    });

    test("names a reference someone else's row says went back", async () => {
      const ours = await bookedWith("sess-s1", "pi_shared_back");
      await bookedWith("sess-s2", "pi_shared_back");
      // Their row is not claimed, so it does not stop us — but it carries the
      // same charge, and that charge has been returned.
      await execute(
        "UPDATE processed_payments SET provider_refunded_at = ? WHERE payment_session_id = ?",
        [new Date(nowMs()).toISOString(), "sess-s2"],
      );

      const held = await claimAttendeeRows([ours], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      // Money back on a reference is back for every row carrying it, whoever
      // they belong to — so our own untouched row must not send it again.
      expect([...held.returned]).toEqual([
        await paymentReferenceIndex("pi_shared_back"),
      ]);
    });

    test("names nothing when the money is still with the provider", async () => {
      const attendeeId = await bookedWith("sess-r", "pi_still_out");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect([...held.returned]).toEqual([]);
    });
  });
});
