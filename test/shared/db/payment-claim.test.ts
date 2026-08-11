import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  claimAttendeeRows,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { paymentReferenceIndex } from "#shared/db/payment-references.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  heldSessionIds,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
  staleClaimSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Read one column off a payment row, by the session that names it. */
const columnOf =
  (column: string) =>
  (sessionId: string): Promise<{ v: string } | null> =>
    queryOne<{ v: string }>(
      `SELECT payment.${column} AS v
         FROM processed_payments AS payment
        WHERE payment.payment_session_id = ?`,
      [sessionId],
    );

const protectedStateOf = columnOf("protected_state");
const referenceIndexOf = columnOf("payment_reference_index");

describeWithEnv("db > payment claim", { db: true, encryptionKey: true }, () => {
  describe("claiming", () => {
    test("an unclaimed attendee's rows are claimed", async () => {
      const attendeeId = await bookedWithPayment("sess-a", "pi_a");
      const result = await claimAttendeeRows([attendeeId], "keyless");
      if (result.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(result)).toEqual(["sess-a"]);
      expect([...result.held.keys()]).toEqual([attendeeId]);
    });

    test("the claim shows in the plaintext mirror the prune reads", async () => {
      const attendeeId = await bookedWithPayment("sess-b", "pi_b");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(held.heldSince).not.toBe("");
      // The prune cannot decrypt, so the mirror is all it has to go on: this
      // word is what keeps a claimed row from being deleted out from under a
      // refund that may already be on its way.
      expect(await protectedStateOf("sess-b")).toEqual({ v: CLAIM_MIRROR });
    });

    test("a second run on the same attendee is told the work is in progress", async () => {
      const attendeeId = await bookedWithPayment("sess-c", "pi_c");
      await claimAttendeeRows([attendeeId], "keyless");
      expect(await claimAttendeeRows([attendeeId], "keyless")).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("two concurrent runs on one attendee: exactly one wins", async () => {
      const attendeeId = await bookedWithPayment("sess-d", "pi_d");
      const results = await Promise.all([
        claimAttendeeRows([attendeeId], "keyless"),
        claimAttendeeRows([attendeeId], "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "blocked")).toHaveLength(1);
    });

    test("two attendees sharing one reference: only one may hold the money", async () => {
      const first = await bookedWithPayment("sess-e1", "pi_shared");
      const second = await bookedWithPayment("sess-e2", "pi_shared");

      const held = await claimAttendeeRows([first], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(held)).toEqual(["sess-e1"]);
      // The second attendee's own row is untouched, but the money behind it is
      // already claimed by someone we cannot take over, so this run must not
      // reach the provider.
      expect(await claimAttendeeRows([second], "keyless")).toEqual({
        blockedBy: { kind: "foreign" },
        kind: "blocked",
      });
    });

    test("two attendees sharing one reference, claimed concurrently: one wins", async () => {
      const first = await bookedWithPayment("sess-f1", "pi_race");
      const second = await bookedWithPayment("sess-f2", "pi_race");
      const results = await Promise.all([
        claimAttendeeRows([first], "keyless"),
        claimAttendeeRows([second], "keyless"),
      ]);
      expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    });

    test("a claim on one attendee leaves an unrelated attendee free", async () => {
      const first = await bookedWithPayment("sess-g1", "pi_g1");
      const second = await bookedWithPayment("sess-g2", "pi_g2");
      await claimAttendeeRows([first], "keyless");
      const second_ = await claimAttendeeRows([second], "keyless");
      if (second_.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(second_)).toEqual(["sess-g2"]);
    });
  });

  describe("the reference index", () => {
    test("is written by the same statement as the reference", async () => {
      await bookedWithPayment("sess-h", "pi_h");
      expect(await referenceIndexOf("sess-h")).toEqual({
        v: await paymentReferenceIndex("pi_h"),
      });
    });

    test("is the same for the same reference on two rows", async () => {
      await bookedWithPayment("sess-i1", "pi_same");
      await bookedWithPayment("sess-i2", "pi_same");
      expect(await referenceIndexOf("sess-i1")).toEqual(
        await referenceIndexOf("sess-i2"),
      );
    });

    test("differs for different references", async () => {
      await bookedWithPayment("sess-j1", "pi_one");
      await bookedWithPayment("sess-j2", "pi_two");
      expect(await referenceIndexOf("sess-j1")).not.toEqual(
        await referenceIndexOf("sess-j2"),
      );
    });

    test("never stores the reference itself", async () => {
      await bookedWithPayment("sess-k", "pi_secret");
      const stored = await referenceIndexOf("sess-k");
      // The setup just wrote this row, so a missing one is a broken test, not
      // an outcome to branch on.
      if (stored === null) throw new Error("the payment row was not stored");
      expect(stored.v).toBe(await paymentReferenceIndex("pi_secret"));
      expect(stored.v).not.toContain("pi_secret");
    });
  });

  describe("releasing", () => {
    test("a released row can be claimed again", async () => {
      const attendeeId = await bookedWithPayment("sess-l", "pi_l");
      const claimed = await claimAttendeeRows([attendeeId], "keyless");
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows({
        heldSince: claimed.heldSince,
        sessionIds: ["sess-l"],
      });
      expect(await claimAttendeeRows([attendeeId], "keyless")).toMatchObject({
        kind: "claimed",
      });
    });

    test("releasing a reviewed row leaves its review showing", async () => {
      // The claim goes, but the owner review it was sitting on top of stays —
      // and the mirror is all the prune and the orphan purge can see, so
      // clearing it outright would hand them a row nobody has looked at yet.
      const attendeeId = await bookedWithPayment("sess-rev", "pi_rev");
      await putRowState(
        "sess-rev",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(await protectedStateOf("sess-rev")).toEqual({ v: CLAIM_MIRROR });

      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-rev"],
      });

      expect(await protectedStateOf("sess-rev")).toEqual({ v: REVIEW_MIRROR });
    });

    test("money the ledger missed is marked as the hold comes off", async () => {
      // The provider sent this money back and our books do not have it. The
      // claim is the wrong thing to keep — it would stop any later run picking
      // the attendee up, and both delete and merge, for good — but the row is
      // the repair target, so it cannot go unprotected either. The mark does
      // one without the other, and lands in the same write as the release so
      // there is no moment where neither holds.
      const attendeeId = await bookedWithPayment("sess-off", "pi_off");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-off"],
        unrecorded: new Set(["sess-off"]),
      });

      expect(await protectedStateOf("sess-off")).toEqual({
        v: UNRECORDED_MIRROR,
      });
      // And it really is free to be claimed again, which is what lets a later
      // run post the ledger entry that retires it.
      expect(await claimAttendeeRows([attendeeId], "keyless")).toMatchObject({
        kind: "claimed",
      });
    });

    test("a later run that records the money takes the mark off", async () => {
      const attendeeId = await bookedWithPayment("sess-on", "pi_on");
      await putRowState(
        "sess-on",
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      // Letting go without naming it is how the state retires: the run that
      // finally got the ledger entry in has nothing left to protect.
      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-on"],
      });

      expect(await protectedStateOf("sess-on")).toEqual({ v: "" });
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWithPayment("sess-m", "pi_m");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-m"],
      });
      expect(await protectedStateOf("sess-m")).toEqual({ v: "" });
    });

    test("releasing nothing reaches no database at all", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        await releaseAttendeeRows({
          heldSince: "2026-08-10T12:00:00.000Z",
          sessionIds: [],
        });
      });
      expect(calls).toBe(0);
    });

    test("claiming nobody holds nothing and reaches no database", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        const nobody = await claimAttendeeRows([], "keyless");
        if (nobody.kind !== "claimed") throw new Error("refused");
        expect(heldSessionIds(nobody)).toEqual([]);
      });
      expect(calls).toBe(0);
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWithPayment("sess-n", "pi_n");
      await releaseAttendeeRows({
        heldSince: "2026-08-10T12:00:00.000Z",
        sessionIds: ["sess-n"],
      });
      expect(await protectedStateOf("sess-n")).toEqual({ v: "" });
    });
  });

  describe("a stalled run waking up", () => {
    // A claim that is INHERITED rather than granted carries the dead run's
    // doubt: it never said what its money did. The run that picks the rows up
    // has to be told, or learning nothing this time reads as settling it.
    test("names the attendees whose hold was inherited", async () => {
      const attendeeId = await bookedWithPayment("sess-inherit", "pi_inherit");
      await putRowState(
        "sess-inherit",
        await staleClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );

      const claimed = await claimAttendeeRows([attendeeId], "keyless");

      expect(claimed).toMatchObject({
        inherited: new Map([[attendeeId, "keyless"]]),
        kind: "claimed",
      });
    });

    // The risk belongs to the call that was made, not to whatever provider is
    // selected now. An operator switching to Stripe must not turn a SumUp
    // hold into a releasable one.
    test("keeps the capability the original call was made under", async () => {
      const attendeeId = await bookedWithPayment("sess-keep", "pi_keep");
      await putRowState(
        "sess-keep",
        await staleClaimSlot(attendeeId, "keyless"),
        CLAIM_MIRROR,
      );

      const resumed = await claimAttendeeRows([attendeeId], "keyed");
      if (resumed.kind !== "claimed") throw new Error("the resume was refused");

      expect(resumed.inherited).toEqual(new Map([[attendeeId, "keyless"]]));
    });

    test("a fresh grant is not an inherited hold", async () => {
      const attendeeId = await bookedWithPayment("sess-grant", "pi_grant");

      expect(await claimAttendeeRows([attendeeId], "keyless")).toMatchObject({
        inherited: new Map(),
      });
    });

    test("does not strip the claim a later run now holds", async () => {
      const attendeeId = await bookedWithPayment("sess-stall", "pi_stall");
      const stalled = await claimAttendeeRows([attendeeId], "keyless");
      if (stalled.kind !== "claimed") throw new Error("the claim was refused");
      expect(stalled.inherited).toEqual(new Map());

      // A later run resumed these rows and holds them now. The stalled run
      // waking up must not hand its successor's work to a third run.
      await releaseAttendeeRows({
        heldSince: stalled.heldSince,
        sessionIds: heldSessionIds(stalled),
      });
      const resumed = await claimAttendeeRows([attendeeId], "keyless");
      if (resumed.kind !== "claimed") throw new Error("the resume was refused");

      await releaseAttendeeRows({
        heldSince: stalled.heldSince,
        sessionIds: heldSessionIds(stalled),
      });

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
      const other = await bookedWithPayment("sess-p1", "pi_shared_stale");
      const ours = await bookedWithPayment("sess-p2", "pi_shared_stale");
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
      const attendeeId = await bookedWithPayment("sess-q", "pi_already_back");
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
      const ours = await bookedWithPayment("sess-s1", "pi_shared_back");
      await bookedWithPayment("sess-s2", "pi_shared_back");
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
      const attendeeId = await bookedWithPayment("sess-r", "pi_still_out");
      const held = await claimAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect([...held.returned]).toEqual([]);
    });
  });
});
