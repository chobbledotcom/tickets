import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getNoteRows, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import {
  expectAcknowledgedIgnore,
  expectNoAttendees,
  expectReplayOutcome,
  expectStoredRefund,
  redirectRequest,
  runFailedRefund,
  runWebhook,
  setupWithListing,
  signedMeta,
  stubRefundOk,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem, webhookMeta } from "#test-utils/factories.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

describeWithEnv(
  "webhook signed price oracle — stored refunds & ignores",
  { db: true },
  () => {
    // Delivers the webhook, then delivers it again, asserting both return the
    // same `processed` result. A redelivery must replay the first outcome —
    // never finalize a refunded booking or re-refund on the second pass.
    const expectDeliveryReplays = async (processed: boolean) => {
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(processed);
      });
      await assertJson(webhookRequest(), 200, (json) => {
        expect(json.processed).toBe(processed);
      });
    };

    test("stores the booking, reverses the ledger with the reason code, and flags it", async () => {
      const listing = await setupWithListing();
      // Signed and charged at 999, but the live price is 1000 — a mid-checkout edit.
      await expectReplayOutcome(
        {
          amount_total: 999,
          id: "cs_ledger_reversal",
          metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
        },
        { processed: false, refundCalls: 1 },
      );
      const [attendee] = await getAttendeesRaw(listing.id);
      expect(attendee).toBeDefined();
      // Stored as a quantity-0 placeholder: it consumes no capacity and is not
      // a ticket, just a kept record of a refunded booking.
      expect(attendee!.quantity).toBe(0);

      // The ledger holds ONLY the cash round-trip — a `payment` we received and
      // a `refund_cash` returning it, stamped with the PII-free reason code — so
      // the attendee nets back to zero. Crucially there is NO `sale` leg: the
      // booking was never honoured, so no revenue is recognised and the
      // quantity-0 line's projected price_paid stays 0 (the no-quantity invariant).
      const account = attendeeAccount(attendee!.id);
      const legs = await transfersByAccount(account);
      const refundCash = legs.find((leg) => leg.kind === "refund_cash");
      expect(refundCash?.memo).toBe("price_changed");
      expect(balanceOf(account)(legs)).toBe(0);
      expect(legs.some((leg) => leg.kind === "payment")).toBe(true);
      expect(legs.some((leg) => leg.kind === "sale")).toBe(false);

      // The system note names the reason (PII-free) and links to the ledger.
      const notes = await getNotesFor(
        attendeeNotes(attendee!.id),
        await getTestPrivateKey(),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toContain("price changed");
      expect(notes[0]!.note).toContain(
        `/admin/ledger/attendee/${attendee!.id}`,
      );
    });

    // ---- session-state invariants (regression: the finalize/store-refund seam) -
    // The store-refund path hinges on a subtle transaction invariant: the attendee
    // is created, but the payment session is deliberately NOT finalized, so the
    // refund is recorded as the session's terminal outcome (and a replay shows the
    // refund message) rather than a finalized success that would replay a ticket.
    // This seam has been re-fought (e.g. the atomic-finalize change), and a green
    // typecheck does NOT catch a regression here — only these assertions do.

    test("a stored-refunded booking leaves the session unfinalized with a terminal refund", async () => {
      const listing = await setupWithListing();
      await expectReplayOutcome(
        {
          amount_total: 999,
          id: "cs_unfinalized",
          metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
        },
        { processed: false, refundCalls: 1 },
      );
      // The booking exists in the diary…
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
      // …but the session is NOT finalized: attendee_id stays null and the refund
      // is the terminal outcome. If a change finalizes it, a replay would wrongly
      // hand the customer a ticket — so pin both fields.
      const record = await getProcessedPayment("cs_unfinalized");
      expect(record?.attendee_id).toBeNull();
      expect(record?.failure_data).not.toBe("");
    });

    test("a redelivery of a stored-refunded booking replays the refund — no re-create, no re-refund, no ticket", async () => {
      const listing = await setupWithListing();
      await runWebhook(
        {
          amount_total: 999,
          id: "cs_replay_refund",
          metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
        },
        async (refund) => {
          // The redelivery must replay the SAME refund outcome (processed:false), not
          // a finalized success (processed:true / a ticket) — and must not duplicate
          // the booking or re-refund. This is the exact failure an over-eager finalize
          // would cause, which the type system can't see.
          await expectDeliveryReplays(false);
          expect((await getAttendeesRaw(listing.id)).length).toBe(1);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a successful booking DOES finalize the session atomically (the contrast)", async () => {
      const listing = await setupWithListing();
      await runWebhook(
        {
          id: "cs_finalized",
          metadata: signedMeta(1000, {
            items: singleItem(listing.id, 1, 1000),
          }),
        },
        async () => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.processed).toBe(true);
          });
          const [attendee] = await getAttendeesRaw(listing.id);
          // A success finalizes (attendee_id set in the same transaction as the
          // attendee insert), so its replay returns the ticket. The store-refund path
          // is the deliberate exception above; keep the two from drifting together.
          const record = await getProcessedPayment("cs_finalized");
          expect(record?.attendee_id).toBe(attendee!.id);
        },
      );
    });

    test("an unexpected error after the charge keeps the booking at quantity 0 and refunds", async () => {
      const listing = await setupWithListing();
      // Make the real-quantity happy-path create (the batch booking write) throw,
      // while the quantity-0 placeholder store (createAttendeeAtomic) keeps working
      // — so a signed payment that hits an unexpected error after the charge is kept
      // at quantity 0 and refunded, not crash-looped over money already taken.
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const boom = stub(attendeesApi, "createBookingAtomic", () =>
        Promise.reject(new Error("synthetic create failure")),
      );
      try {
        await runWebhook(
          {
            id: "cs_crash_store",
            metadata: signedMeta(1000, {
              items: singleItem(listing.id, 1, 1000),
            }),
          },
          async (refund) => {
            await expectStoredRefund(listing.id);
            expect(refund.calls.length).toBe(1);
            const record = await getProcessedPayment("cs_crash_store");
            expect(record?.attendee_id).toBeNull();
            expect(record?.failure_data).not.toBe("");
          },
        );
      } finally {
        boom.restore();
      }
    });

    test("a signed session for a since-deleted listing is kept as a ghost and refunded", async () => {
      await setupStripe();
      // No listing with this id exists (as if deleted between checkout and the
      // webhook). The proof still proves the session is ours, so rather than drop a
      // paid customer we keep a quantity-0 ghost against the dead listing id (there
      // is no FK to listings), refund, and flag it — never the foreign-session
      // no-refund path.
      await runWebhook(
        {
          id: "cs_missing_listing",
          metadata: signedMeta(1000, { items: singleItem(999999, 1, 1000) }),
        },
        async (refund) => {
          await expectStoredRefund(999999);
          expect(refund.calls.length).toBe(1);
          // Recorded as the session's terminal outcome (not finalized → no ticket).
          const record = await getProcessedPayment("cs_missing_listing");
          expect(record?.attendee_id).toBeNull();
          expect(record?.failure_data).not.toBe("");
        },
      );
    });

    // ---- ignore: acknowledge, never refund ------------------------------------

    test("a tampered proof is ignored without refunding", async () => {
      const listing = await setupWithListing();
      // A valid-looking total but a wrong digest — the proof no longer verifies.
      const metadata = {
        ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
        price_proof: `1000.${"A".repeat(44)}`,
      };
      await runWebhook({ id: "cs_tampered", metadata }, async (refund) => {
        await expectAcknowledgedIgnore();
        expect(refund.calls.length).toBe(0);
        await expectNoAttendees(listing.id);
      });
    });

    test("a malformed price proof is ignored without refunding", async () => {
      const listing = await setupWithListing();
      const metadata = {
        ...webhookMeta({
          email: "badtotal@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Bad Total Buyer",
        }),
        price_proof: "not-a-number",
      };
      await runWebhook({ id: "cs_bad_total", metadata }, async (refund) => {
        await expectAcknowledgedIgnore();
        expect(refund.calls.length).toBe(0);
        await expectNoAttendees(listing.id);
      });
    });

    test("an unsigned session is ignored without refunding", async () => {
      const listing = await setupWithListing();
      // Plain webhookMeta carries no proof — there is no longer a re-derived
      // fallback, so without a proof we cannot prove the session is ours.
      const metadata = webhookMeta({
        email: "legacy@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Legacy Buyer",
      });
      await runWebhook({ id: "cs_unsigned", metadata }, async (refund) => {
        await expectAcknowledgedIgnore();
        expect(refund.calls.length).toBe(0);
        await expectNoAttendees(listing.id);
      });
    });

    test("a session with corrupt items is ignored without parsing or refunding", async () => {
      const listing = await setupWithListing();
      // Signed, then items replaced with junk: the proof no longer verifies, so the
      // session is ignored before the items are ever parsed (no throw, no refund).
      const metadata = {
        ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
        items: "not-json",
      };
      await runWebhook({ id: "cs_corrupt_items", metadata }, async (refund) => {
        await expectAcknowledgedIgnore();
        expect(refund.calls.length).toBe(0);
        await expectNoAttendees(listing.id);
      });
    });

    test("an unsigned foreign-origin webhook is ignored without refunding", async () => {
      const listing = await setupWithListing();
      // No proof and a foreign _origin: a different instance sharing the provider.
      const metadata = {
        ...webhookMeta({
          email: "foreign@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Foreign Unsigned",
        }),
        _origin: "other-instance.example.test",
      };
      await runWebhook(
        { id: "cs_foreign_unsigned", metadata },
        async (refund) => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.received).toBe(true);
          });
          expect(refund.calls.length).toBe(0);
          await expectNoAttendees(listing.id);
        },
      );
    });

    test("an unverifiable session on the redirect path is not recognized and not refunded", async () => {
      await setupStripe();
      // A paid session from another instance arriving on the success redirect: its
      // proof was signed with a different key (invalid to us), so we show the
      // not-recognized page and never refund another instance's payment.
      const metadata = {
        ...signedMeta(1000, { items: singleItem(999999, 1, 1000) }),
        _origin: "other-instance.example.test",
        price_proof: `1000.${"A".repeat(44)}`,
      };
      const refund = stubRefundOk();
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        metadata,
        paymentIntent: "pi_cs_foreign_redirect",
        sessionId: "cs_foreign_redirect",
      });
      try {
        const response = await redirectRequest("cs_foreign_redirect");
        expect(await response.text()).toContain("not recognized");
        expect(refund.calls.length).toBe(0);
      } finally {
        retrieve.restore();
        refund.restore();
      }
    });

    // ---- failed-refund behaviour for a stored booking -------------------------

    test("a stored booking whose refund fails is kept, flagged, and recorded as terminal", async () => {
      const listing = await setupWithListing();
      // The provider refund keeps failing and the payment is not yet refunded. The
      // booking is already stored (signed by us → never dropped), so a retry must
      // NOT re-create it: the outcome is recorded as terminal and the system note
      // tells the operator to refund it manually, rather than looping a 503 retry
      // that would duplicate the booking.
      await runFailedRefund(
        "cs_refund_retry",
        false,
        listing.id,
        async (refund) => {
          // A second delivery replays the recorded outcome — it does not re-create the
          // attendee or re-attempt the (now operator-owned) refund.
          await expectDeliveryReplays(false);
          expect(refund.calls.length).toBe(1);
          const [attendee] = await getAttendeesRaw(listing.id);
          expect(attendee?.quantity).toBe(0);
          expect(await getNoteRows("attendee", [attendee!.id])).toHaveLength(1);
          const record = await getProcessedPayment("cs_refund_retry");
          expect(record?.failure_data).not.toBe("");
        },
      );
    });
  },
);
