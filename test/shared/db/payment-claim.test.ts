import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  clearReturnedUnrecorded,
  markReturnedUnrecorded,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
  storedRecordOf,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("db > payment claim", { db: true, encryptionKey: true }, () => {
  describe("releasing", () => {
    test("a released row can be claimed again", async () => {
      const attendeeId = await bookedWithPayment("sess-l", "pi_l");
      const claimed = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows({
        heldSince: claimed.heldSince,
        sessionIds: ["sess-l"],
      });
      expect(
        await claimCurrentAttendeeRows([attendeeId], "keyless"),
      ).toMatchObject({
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
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(await protectedStateOf("sess-rev")).toBe(CLAIM_MIRROR);

      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-rev"],
      });

      expect(await protectedStateOf("sess-rev")).toBe(REVIEW_MIRROR);
    });

    test("money the ledger missed is marked as the hold comes off", async () => {
      // The provider sent this money back and our books do not have it. The
      // claim is the wrong thing to keep — it would stop any later run picking
      // the attendee up, and both delete and merge, for good — but the row is
      // the repair target, so it cannot go unprotected either. The mark does
      // one without the other, and lands in the same write as the release so
      // there is no moment where neither holds.
      const attendeeId = await bookedWithPayment("sess-off", "pi_off");
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-off"],
        unrecorded: new Set(["sess-off"]),
      });

      expect(await protectedStateOf("sess-off")).toBe(UNRECORDED_MIRROR);
      // And it really is free to be claimed again, which is what lets a later
      // run post the ledger entry that retires it.
      expect(
        await claimCurrentAttendeeRows([attendeeId], "keyless"),
      ).toMatchObject({
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
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      // Letting go without naming it is how the state retires: the run that
      // finally got the ledger entry in has nothing left to protect.
      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-on"],
      });

      expect(await protectedStateOf("sess-on")).toBe("");
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWithPayment("sess-m", "pi_m");
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await releaseAttendeeRows({
        heldSince: held.heldSince,
        sessionIds: ["sess-m"],
      });
      expect(await protectedStateOf("sess-m")).toBe("");
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

    // The refresh route finds money already back at the provider and can be
    // run again and again. Each run must not move the date, or the age of a
    // problem somebody is meant to be looking into resets every time they
    // look at it.
    test("saying the books are behind twice leaves the first answer alone", async () => {
      await bookedWithPayment("sess-twice", "pi_twice");
      await markReturnedUnrecorded(["sess-twice"]);
      const first = await storedRecordOf("sess-twice");

      const calls = await countDatabaseCalls(1, () =>
        markReturnedUnrecorded(["sess-twice"]),
      );

      expect(calls).toBe(1);
      expect(await storedRecordOf("sess-twice")).toBe(first);
      expect(await protectedStateOf("sess-twice")).toBe(UNRECORDED_MIRROR);
    });

    test("clearing returned money retires its books-behind mark", async () => {
      await bookedWithPayment("sess-clear", "pi_clear");
      await markReturnedUnrecorded(["sess-clear"]);

      await clearReturnedUnrecorded(["sess-clear"]);

      expect(await protectedStateOf("sess-clear")).toBe("");
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWithPayment("sess-n", "pi_n");
      await releaseAttendeeRows({
        heldSince: "2026-08-10T12:00:00.000Z",
        sessionIds: ["sess-n"],
      });
      expect(await protectedStateOf("sess-n")).toBe("");
    });
  });
});
