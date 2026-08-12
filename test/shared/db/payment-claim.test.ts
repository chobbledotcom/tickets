import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTransaction } from "#shared/db/client.ts";
import {
  assertRefundRowsHeld,
  type PaymentRowSettlement,
  settleAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const releaseRows = (
  heldSince: string,
  sessionIds: readonly string[],
  changes: ReadonlyMap<string, Omit<PaymentRowSettlement, "claim">> = new Map(),
): Promise<void> =>
  settleAttendeeRows({
    heldSince,
    rows: new Map(
      sessionIds.map((sessionId) => [
        sessionId,
        { ...changes.get(sessionId), claim: "release" } as const,
      ]),
    ),
  });

describeWithEnv("db > payment claim", { db: true, encryptionKey: true }, () => {
  describe("releasing", () => {
    test("confirmation accepts only the exact claim still holding every row", async () => {
      const attendeeId = await bookedWithPayment("sess-confirm", "pi_confirm");
      const claimed = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");

      await withTransaction((tx) =>
        assertRefundRowsHeld(tx, {
          heldSince: claimed.heldSince,
          sessionIds: ["sess-confirm"],
        })
      );
      await releaseRows(claimed.heldSince, ["sess-confirm"]);

      await expect(
        withTransaction((tx) =>
          assertRefundRowsHeld(tx, {
            heldSince: claimed.heldSince,
            sessionIds: ["sess-confirm"],
          })
        ),
      ).rejects.toThrow("Refund confirmation no longer owns every payment row");
    });

    test("a released row can be claimed again", async () => {
      const attendeeId = await bookedWithPayment("sess-l", "pi_l");
      const claimed = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");
      await releaseRows(claimed.heldSince, ["sess-l"]);
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

      await releaseRows(held.heldSince, ["sess-rev"]);

      expect(await protectedStateOf("sess-rev")).toBe(REVIEW_MIRROR);
    });

    test("installs and retires an owner review as the claim comes off", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-new-review",
        "pi_new_review",
      );
      const first = await claimCurrentAttendeeRows([attendeeId], "keyed");
      if (first.kind !== "claimed") throw new Error("the claim was refused");

      await releaseRows(
        first.heldSince,
        ["sess-new-review"],
        new Map([
          [
            "sess-new-review",
            {
              review: {
                kind: "review",
                reason: { kind: "partial_refund" },
              },
            },
          ],
        ]),
      );
      expect(await protectedStateOf("sess-new-review")).toBe(REVIEW_MIRROR);

      const second = await claimCurrentAttendeeRows([attendeeId], "keyed");
      if (second.kind !== "claimed") throw new Error("the claim was refused");
      await releaseRows(
        second.heldSince,
        ["sess-new-review"],
        new Map([
          [
            "sess-new-review",
            { review: { kind: "resolved", reason: "partial_refund" } },
          ],
        ]),
      );
      expect(await protectedStateOf("sess-new-review")).toBe("");
    });

    test("does not retire a different review that replaced the expected one", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-changed-review",
        "pi_changed_review",
      );
      await putRowState(
        "sess-changed-review",
        await rowStateSlot({ review: { kind: "shared_reference" } }),
        REVIEW_MIRROR,
      );
      const held = await claimCurrentAttendeeRows([attendeeId], "keyed");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseRows(
        held.heldSince,
        ["sess-changed-review"],
        new Map([
          [
            "sess-changed-review",
            { review: { kind: "resolved", reason: "partial_refund" } },
          ],
        ]),
      );

      const reclaimed = await claimCurrentAttendeeRows([attendeeId], "keyed");
      if (reclaimed.kind !== "claimed") {
        throw new Error("the reviewed row could not be reclaimed");
      }
      expect(reclaimed.reviews.get("sess-changed-review")).toEqual({
        kind: "shared_reference",
      });
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

      await releaseRows(
        held.heldSince,
        ["sess-off"],
        new Map([["sess-off", { books: "unrecorded" }]]),
      );

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
      await releaseRows(
        held.heldSince,
        ["sess-on"],
        new Map([["sess-on", { books: "recorded" }]]),
      );

      expect(await protectedStateOf("sess-on")).toBe("");
    });

    test("settling one reference preserves a sibling's older repair marker", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-still-behind",
        "pi_still_behind",
      );
      await finalizeProcessedPayment(
        "sess-newly-behind",
        attendeeId,
        "tok-new",
      );
      await putRowState(
        "sess-still-behind",
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseRows(
        held.heldSince,
        ["sess-still-behind", "sess-newly-behind"],
        new Map([["sess-newly-behind", { books: "unrecorded" }]]),
      );

      expect(await protectedStateOf("sess-still-behind")).toBe(
        UNRECORDED_MIRROR,
      );
      expect(await protectedStateOf("sess-newly-behind")).toBe(
        UNRECORDED_MIRROR,
      );
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWithPayment("sess-m", "pi_m");
      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await releaseRows(held.heldSince, ["sess-m"]);
      expect(await protectedStateOf("sess-m")).toBe("");
    });

    test("releasing nothing reaches no database at all", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        await releaseRows("2026-08-10T12:00:00.000Z", []);
      });
      expect(calls).toBe(0);
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWithPayment("sess-n", "pi_n");
      await releaseRows("2026-08-10T12:00:00.000Z", ["sess-n"]);
      expect(await protectedStateOf("sess-n")).toBe("");
    });
  });
});
