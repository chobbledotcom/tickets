import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import {
  asPaymentRowRecord,
  assertRefundRowsHeld,
  readAttendeeRowStates,
} from "#db/payment-claim.ts";
import type { PaymentReviewReason } from "#payment/review.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  releaseClaimRows,
  reviewCase,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const claimedPhase = (
  claim: { phases: ReadonlyMap<string, "checking"> },
  sessionId: string,
): "checking" => {
  const phase = claim.phases.get(sessionId);
  if (phase === undefined) {
    throw new Error(`Claim did not include payment row ${sessionId}`);
  }
  return phase;
};

const putUnrecordedRow = async (sessionId: string): Promise<void> => {
  await putRowState(
    sessionId,
    await rowStateSlot({
      unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
    }),
    UNRECORDED_MIRROR,
  );
};

const reviewOf = async (attendeeId: number) =>
  (await withTransaction((tx) => readAttendeeRowStates(tx, [attendeeId])))[0]
    ?.state.review;

describeWithEnv("db > payment claim", { db: true, encryptionKey: true }, () => {
  test("rejects an invalid provider-work projection at the database boundary", async () => {
    await expect(
      asPaymentRowRecord({
        attendee_id: 1,
        failure_data: "",
        payment_reference_index: "reference-index",
        payment_session_id: "session-one",
        provider_refund_work: 2,
        refund_state_name: null,
      }),
    ).rejects.toThrow("Provider refund work projection is invalid");
  });

  describe("releasing", () => {
    test("confirmation accepts only the exact claim still holding every row", async () => {
      const attendeeId = await bookedWithPayment("sess-confirm", "pi_confirm");
      const claimed = await claimCurrentAttendeeRows([attendeeId]);
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");

      await withTransaction((tx) =>
        assertRefundRowsHeld(tx, {
          commandId: claimed.commandId,
          heldSince: claimed.heldSince,
          phases: new Map([
            ["sess-confirm", claimedPhase(claimed, "sess-confirm")],
          ]),
        }),
      );
      await releaseClaimRows(claimed, ["sess-confirm"]);

      await expect(
        withTransaction((tx) =>
          assertRefundRowsHeld(tx, {
            commandId: claimed.commandId,
            heldSince: claimed.heldSince,
            phases: new Map([
              ["sess-confirm", claimedPhase(claimed, "sess-confirm")],
            ]),
          }),
        ),
      ).rejects.toThrow("Refund confirmation no longer owns every payment row");
    });

    test("confirmation accepts an empty held set", async () => {
      await withTransaction((tx) =>
        assertRefundRowsHeld(tx, {
          commandId: "empty-command",
          heldSince: "2026-08-11T12:00:00.000Z",
          phases: new Map(),
        }),
      );
    });

    test("a released row can be claimed again", async () => {
      const attendeeId = await bookedWithPayment("sess-l", "pi_l");
      const claimed = await claimCurrentAttendeeRows([attendeeId]);
      if (claimed.kind !== "claimed") throw new Error("the claim was refused");
      await releaseClaimRows(claimed, ["sess-l"]);
      expect(await claimCurrentAttendeeRows([attendeeId])).toMatchObject({
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
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        REVIEW_MIRROR,
      );
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(await protectedStateOf("sess-rev")).toBe(CLAIM_MIRROR);

      await releaseClaimRows(held, ["sess-rev"]);

      expect(await protectedStateOf("sess-rev")).toBe(REVIEW_MIRROR);
    });

    test("installs and retires an owner review as the claim comes off", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-new-review",
        "pi_new_review",
      );
      const first = await claimCurrentAttendeeRows([attendeeId]);
      if (first.kind !== "claimed") throw new Error("the claim was refused");

      await releaseClaimRows(
        first,
        ["sess-new-review"],
        new Map([
          [
            "sess-new-review",
            {
              review: {
                kind: "review",
                reason: { kind: "partially_returned_obligation" },
              },
            },
          ],
        ]),
      );
      expect(await protectedStateOf("sess-new-review")).toBe(REVIEW_MIRROR);

      const second = await claimCurrentAttendeeRows([attendeeId]);
      if (second.kind !== "claimed") throw new Error("the claim was refused");
      await releaseClaimRows(
        second,
        ["sess-new-review"],
        new Map([
          [
            "sess-new-review",
            {
              review: {
                kind: "resolved",
                reason: "partially_returned_obligation",
              },
            },
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
        await rowStateSlot({
          review: reviewCase({ kind: "shared_reference" }),
        }),
        REVIEW_MIRROR,
      );
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseClaimRows(
        held,
        ["sess-changed-review"],
        new Map([
          [
            "sess-changed-review",
            {
              review: {
                kind: "resolved",
                reason: "partially_returned_obligation",
              },
            },
          ],
        ]),
      );

      const reclaimed = await claimCurrentAttendeeRows([attendeeId]);
      if (reclaimed.kind !== "claimed") {
        throw new Error("the reviewed row could not be reclaimed");
      }
      expect(reclaimed.reviews.get("sess-changed-review")).toEqual({
        kind: "shared_reference",
      });
    });

    test("keeps acknowledgement for the same issue and reopens a changed issue", async () => {
      const attendeeId = await bookedWithPayment("sess-review-case", "pi_case");
      const acknowledged = {
        ...reviewCase(
          { kind: "partially_returned_obligation" },
          "acknowledged-case",
        ),
        acknowledgedAt: "2026-08-12T13:00:00.000Z",
      };
      await putRowState(
        "sess-review-case",
        await rowStateSlot({ review: acknowledged }),
        REVIEW_MIRROR,
      );
      const settleWith = async (kind: PaymentReviewReason["kind"]) => {
        const held = await claimCurrentAttendeeRows([attendeeId]);
        if (held.kind !== "claimed") throw new Error("review row was refused");
        await releaseClaimRows(
          held,
          ["sess-review-case"],
          new Map([
            [
              "sess-review-case",
              {
                review: { kind: "review", reason: { kind } },
              },
            ],
          ]),
        );
      };

      await settleWith("partially_returned_obligation");
      expect(await reviewOf(attendeeId)).toEqual(acknowledged);
      await settleWith("shared_reference");
      const reopened = await reviewOf(attendeeId);
      expect(reopened?.reason).toEqual({ kind: "shared_reference" });
      expect(reopened?.caseId).not.toBe("acknowledged-case");
      expect(reopened?.acknowledgedAt).toBeUndefined();
    });

    test("money the ledger missed is marked as the hold comes off", async () => {
      // The provider sent this money back and our books do not have it. The
      // claim is the wrong thing to keep — it would stop any later run picking
      // the attendee up, and both delete and merge, for good — but the row is
      // the repair target, so it cannot go unprotected either. The mark does
      // one without the other, and lands in the same write as the release so
      // there is no moment where neither holds.
      const attendeeId = await bookedWithPayment("sess-off", "pi_off");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseClaimRows(
        held,
        ["sess-off"],
        new Map([["sess-off", { books: "unrecorded" }]]),
      );

      expect(await protectedStateOf("sess-off")).toBe(UNRECORDED_MIRROR);
      // And it really is free to be claimed again, which is what lets a later
      // run post the ledger entry that retires it.
      expect(await claimCurrentAttendeeRows([attendeeId])).toMatchObject({
        kind: "claimed",
      });
    });

    test("a later run that records the money takes the mark off", async () => {
      const attendeeId = await bookedWithPayment("sess-on", "pi_on");
      await putUnrecordedRow("sess-on");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      // Letting go without naming it is how the state retires: the run that
      // finally got the ledger entry in has nothing left to protect.
      await releaseClaimRows(
        held,
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
      await putUnrecordedRow("sess-still-behind");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");

      await releaseClaimRows(
        held,
        ["sess-still-behind", "sess-newly-behind"],
        new Map([["sess-newly-behind", { books: "unrecorded" }]]),
      );

      expect(await protectedStateOf("sess-still-behind")).toBe(
        UNRECORDED_MIRROR,
      );
      expect(await protectedStateOf("sess-newly-behind")).toBe(
        UNRECORDED_MIRROR,
      );
      expect(
        await withTransaction((tx) => readAttendeeRowStates(tx, [attendeeId])),
      ).toContainEqual(
        expect.objectContaining({
          sessionId: "sess-still-behind",
          state: expect.objectContaining({
            unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
          }),
        }),
      );
    });

    test("releasing clears the mirror the prune reads", async () => {
      const attendeeId = await bookedWithPayment("sess-m", "pi_m");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await releaseClaimRows(held, ["sess-m"]);
      expect(await protectedStateOf("sess-m")).toBe("");
    });

    test("releasing nothing reaches no database at all", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        await releaseClaimRows(
          {
            commandId: "empty-command",
            heldSince: "2026-08-10T12:00:00.000Z",
            phases: new Map(),
          },
          [],
        );
      });
      expect(calls).toBe(0);
    });

    test("releasing an unclaimed row leaves it alone", async () => {
      await bookedWithPayment("sess-n", "pi_n");
      await releaseClaimRows(
        {
          commandId: "missing-command",
          heldSince: "2026-08-10T12:00:00.000Z",
          phases: new Map([["sess-n", "checking"]]),
        },
        ["sess-n"],
      );
      expect(await protectedStateOf("sess-n")).toBe("");
    });
  });
});
