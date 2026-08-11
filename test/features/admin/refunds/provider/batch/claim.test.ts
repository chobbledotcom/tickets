import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  finishedCounts,
  oneFailedRefundCounts,
  pendingCandidate,
  processRefundBatchAt,
  provider,
  unreadableProvider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundReference } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

describeWithEnv(
  "admin refund provider > processRefundBatch > claims",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("counts and reports an unreadable charge without sending", async () => {
      const counts = finishedCounts(
        await processRefundBatchAt(
          provider({ read: () => Promise.resolve(null) }),
          [pendingCandidate(21, ["pi_unreadable"])],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(
        errors.contains(
          "No configured payment provider recognizes this payment. " +
            "Add the provider it was taken with, or refund it from that " +
            "provider's dashboard.",
        ),
      ).toBe(true);
    });

    const heldCandidate = (
      attendeeId: number,
      sessionId: string,
    ): RefundCandidate => ({
      attendee: { id: attendeeId } as RefundCandidate["attendee"],
      references: [
        refundReference(`pi_${sessionId}`, {
          rowSessionIds: [sessionId],
          sessionIds: [sessionId],
        }),
      ],
    });

    test("keeps a resumed keyless hold when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[31, ["sess-31"]]]),
        new Map([[31, "keyless"]]),
      );
      const provider = unreadableProvider("keyless");

      await processRefundBatchAt(
        provider,
        [heldCandidate(31, "sess-31")],
        LISTING,
        { claim },
      );

      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([]);
    });

    test("keeps an inherited keyless hold even when this run is keyed", async () => {
      const claim = grantingRowClaim(
        new Map([[34, ["sess-34"]]]),
        new Map([[34, "keyless"]]),
      );
      const provider = unreadableProvider("keyed");

      await processRefundBatchAt(
        provider,
        [heldCandidate(34, "sess-34")],
        LISTING,
        { claim },
      );

      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([]);
    });

    test("lets a fresh keyless hold go when the provider cannot be read", async () => {
      const claim = grantingRowClaim(new Map([[32, ["sess-32"]]]));
      const provider = unreadableProvider("keyless");

      await processRefundBatchAt(
        provider,
        [heldCandidate(32, "sess-32")],
        LISTING,
        { claim },
      );

      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([["sess-32"]]);
    });

    test("keeps a resumed keyed hold when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[33, ["sess-33"]]]),
        new Map([[33, "keyed"]]),
      );
      const provider = unreadableProvider("keyed");

      await processRefundBatchAt(
        provider,
        [heldCandidate(33, "sess-33")],
        LISTING,
        { claim },
      );

      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([]);
    });
  },
);
