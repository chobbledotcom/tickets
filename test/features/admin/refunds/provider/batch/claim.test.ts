import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  finishedCounts,
  oneFailedRefundCounts,
  pendingCandidate,
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

    test("counts an unreadable charge as not refunded without raising an incident", async () => {
      const counts = finishedCounts(
        await processRefundBatch(
          {
            readCharge: () =>
              Promise.resolve({
                reason: "network_error",
                status: "unavailable",
              } as const),
            refundCapability: "keyed" as const,
            refundCharge: () =>
              Promise.resolve({
                kind: "uncertain",
                reason: "network_error",
              } as const),
          },
          [pendingCandidate(21, ["pi_unreadable"])],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(errors.calls).toHaveLength(0);
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

      await processRefundBatch(
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

      await processRefundBatch(
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

      await processRefundBatch(
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

      await processRefundBatch(
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
