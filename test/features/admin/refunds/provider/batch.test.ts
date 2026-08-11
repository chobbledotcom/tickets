import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import {
  postBooking,
  refundCashAmounts,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney, refundReference } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

/** A candidate already refunded at the provider (its references carry
 * `refundState: "completed"`, so the provider is never called for it). */
const refundedCandidate = (
  attendeeId: number,
  sessionId: string,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [sessionReference(sessionId)],
});

const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) =>
    refundReference(reference, { sessionIds: [] }),
  ),
});

/** Provider that fails every live refund and throws for references in
 * `throws`; used to drive the failed/errored tally branches. */
const failingProvider = (
  throws: Set<string>,
  refundCapability: RefundCapability = "keyed",
) => ({
  readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
  refundCapability,
  refundPayment: (reference: string) => {
    if (throws.has(reference)) throw new Error(`boom ${reference}`);
    return Promise.resolve(false);
  },
});

describeWithEnv(
  "admin refund provider > processRefundBatch",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    // A provider that cannot be reached is an ordinary answer, and the shared
    // reporter already said so at debug. Counting it as not-refunded is right;
    // reporting it AGAIN here as an incident is how one provider outage fills
    // the operator's log with an error per reference.
    test("counts an unreadable charge as not refunded without raising an incident", async () => {
      const counts = await processRefundBatch(
        {
          readChargeMoneyOrNull: () => Promise.resolve(null),
          refundCapability: "keyed" as const,
          refundPayment: () => Promise.resolve(true),
        },
        [pendingCandidate(21, ["pi_unreadable"])],
        LISTING,
        { claim: grantingRowClaim() },
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 1,
        notRecordedCount: 0,
        refundedCount: 0,
      });
      expect(errors.calls).toHaveLength(0);
    });

    /** A provider that cannot be read at all, recording anything it is
     *  nonetheless asked to send. It answers `true` so a run that skipped the
     *  read would look like a success rather than failing on its own. */
    const unreadableProvider = (refundCapability: RefundCapability) => {
      const sent: string[] = [];
      return {
        readChargeMoneyOrNull: () => Promise.resolve(null),
        refundCapability,
        refundPayment: (reference: string) => {
          sent.push(reference);
          return Promise.resolve(true);
        },
        sent,
      };
    };

    /** A candidate whose reference names the very session the hold covers, so
     *  the run recognises its own rows rather than standing down. */
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

    // The fault this closes: a keyless run whose answer was lost leaves its
    // claim standing on purpose. A later run resuming it and then failing to
    // read the provider has learned nothing, so releasing hands the rows to a
    // third run that sees lagging evidence and pays the buyer twice.
    test("keeps a resumed keyless hold when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[31, ["sess-31"]]]),
        new Set([31]),
      );

      const provider = unreadableProvider("keyless");

      await processRefundBatch(
        provider,
        [heldCandidate(31, "sess-31")],
        LISTING,
        { claim },
      );

      // Whatever the hold does, an unreadable provider is never sent money.
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

      // Whatever the hold does, an unreadable provider is never sent money.
      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([["sess-32"]]);
    });

    test("lets a resumed KEYED hold go when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[33, ["sess-33"]]]),
        new Set([33]),
      );

      const provider = unreadableProvider("keyed");

      await processRefundBatch(
        provider,
        [heldCandidate(33, "sess-33")],
        LISTING,
        { claim },
      );

      // Whatever the hold does, an unreadable provider is never sent money.
      expect(provider.sent).toEqual([]);
      expect(claim.released).toEqual([["sess-33"]]);
    });

    test("tallies refunded, failed and errored candidates in one batch", async () => {
      await postBooking({ attendeeId: 11, eventId: "sess-11" });

      const counts = await processRefundBatch(
        failingProvider(new Set(["pi_boom"])),
        [
          refundedCandidate(11, "sess-11"),
          pendingCandidate(12, ["pi_fail"]),
          pendingCandidate(13, ["pi_boom", "pi_two"]),
        ],
        LISTING,
        { claim: grantingRowClaim() },
      );

      expect(counts).toEqual({
        errorCount: 1,
        failedCount: 1,
        notRecordedCount: 0,
        refundedCount: 1,
      });
      expect(errors.contains("Admin bulk refund failed for attendee 12")).toBe(
        true,
      );
      // The errored candidate's references are joined with ", ".
      expect(
        errors.contains(
          "Admin bulk refund errored for attendee 13, payments pi_boom, pi_two",
        ),
      ).toBe(true);
    });

    // The fault this closes: a merged attendee carries several charges, one
    // comes back and a sibling is refused, and the whole candidate combines to
    // "failed" — so the money that DID move used to reach no ledger at all.
    test("records the charges that came back when a sibling is refused", async () => {
      const attendeeId = 31;
      await postBooking({ attendeeId, eventId: "sess-back" });
      await postBooking({ attendeeId, eventId: "sess-stuck" });

      const counts = await processRefundBatch(
        {
          readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
          refundCapability: "keyed" as const,
          refundPayment: (reference: string) =>
            Promise.resolve(reference === "pi_back"),
        },
        [
          {
            attendee: { id: attendeeId } as RefundCandidate["attendee"],
            references: [
              refundReference("pi_back", { sessionIds: ["sess-back"] }),
              refundReference("pi_stuck", { sessionIds: ["sess-stuck"] }),
            ],
          },
        ],
        LISTING,
        { claim: grantingRowClaim() },
      );

      // Not a refunded attendee — one of their charges is still with the
      // provider — but the money that moved is now on the books.
      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 1,
        notRecordedCount: 0,
        refundedCount: 0,
      });
      // Exactly one reversal, for the booking whose charge came back. The
      // stuck booking is left exactly as it was.
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    test("a keyless run whose ledger post failed marks the row and lets go", async () => {
      // No booking is posted, so the reversal finds no order and the post
      // fails. The provider answered clearly, though — the money did go back —
      // so there is no doubt for the hold to guard against, only books that are
      // behind. Keeping the claim here is what left a SumUp attendee stuck for
      // good: ledger-refunded, so no later run picks them up to release it, and
      // refused by both delete and merge. The mark protects the row the
      // correction needs and does none of that.
      const claim = grantingRowClaim(new Map([[21, ["sess-21"]]]));

      const counts = await processRefundBatch(
        failingProvider(new Set(), "keyless"),
        [refundedCandidate(21, "sess-21")],
        LISTING,
        { claim: claim },
      );

      expect(counts.notRecordedCount).toBe(1);
      // A provider that answered clearly is not an uncertain provider: the two
      // are counted apart so only one of them can say the money moved.
      expect(counts.errorCount).toBe(0);
      expect(claim.released).toEqual([["sess-21"]]);
      expect(claim.unrecorded).toEqual([["sess-21"]]);
    });

    test("a keyed run lets go, because a repeat lands on the same refund", async () => {
      const claim = grantingRowClaim(new Map([[22, ["sess-22"]]]));

      await processRefundBatch(
        failingProvider(new Set()),
        [refundedCandidate(22, "sess-22")],
        LISTING,
        { claim: claim },
      );

      expect(claim.released).toHaveLength(1);
    });

    test("returns all-zero counts for an empty batch", async () => {
      const counts = await processRefundBatch(
        failingProvider(new Set()),
        [],
        LISTING,
        { claim: grantingRowClaim() },
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 0,
        notRecordedCount: 0,
        refundedCount: 0,
      });
    });

    test("counts a refund the ledger cannot post apart from an uncertain one", async () => {
      // No booking exists for attendee 21, so the reversal posts nothing and the
      // ledger reports it unposted even though the provider refund succeeded.
      // This is the one case that may say the money moved, so it is counted on
      // its own: an operator told to correct the books and never resend must
      // not be hearing about a provider call that may have done nothing.
      const counts = await processRefundBatch(
        failingProvider(new Set()),
        [refundedCandidate(21, "sess-missing")],
        LISTING,
        { claim: grantingRowClaim() },
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 0,
        notRecordedCount: 1,
        refundedCount: 0,
      });
    });
  },
);
