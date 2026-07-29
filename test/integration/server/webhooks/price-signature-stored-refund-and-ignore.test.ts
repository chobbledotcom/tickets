import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { runPaymentReconciliationMaintenance } from "#shared/payment-runtime/maintenance.ts";
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
import { maintenanceContext } from "#test-utils/maintenance.ts";
import { requirePaymentAggregateByProviderSession } from "#test-utils/payment-aggregate.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

describeWithEnv(
  "webhook signed price oracle — stored refunds & ignores",
  { db: true },
  () => {
    // Delivers the webhook, then delivers it again, asserting both return the
    // same `processed` result. A redelivery must replay the first outcome —
    // never finalize a refunded booking or re-refund on the second pass.
    const expectDeliveryReplays = async (
      status: number,
      expected: Record<string, unknown>,
    ) => {
      await assertJson(webhookRequest(), status, (json) => {
        expect(json).toMatchObject(expected);
      });
      await assertJson(webhookRequest(), status, (json) => {
        expect(json).toMatchObject(expected);
      });
    };

    const runDuePaymentMaintenance = async (paymentId: string) => {
      await getDb().execute(
        "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE id = ?",
        [paymentId],
      );
      await runPaymentReconciliationMaintenance(
        maintenanceContext({ database: 21, external: 11, total: 32 }),
      );
    };

    const priceChangedSession = (listingId: number, id: string) => ({
      amount_total: 999,
      id,
      metadata: signedMeta(999, { items: singleItem(listingId, 1, 1000) }),
    });

    test("defers a stored refund's ledger and note until maintenance", async () => {
      const listing = await setupWithListing();
      await runWebhook(
        priceChangedSession(listing.id, "cs_ledger_reversal"),
        async (refund) => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json).toMatchObject({
              processed: false,
              status: "fully_refunded",
            });
          });
          const [attendee] = await getAttendeesRaw(listing.id);
          expect(attendee?.quantity).toBe(0);
          const account = attendeeAccount(attendee!.id);
          expect(await transfersByAccount(account)).toEqual([]);
          expect(
            await getNotesFor(attendeeNotes(attendee!.id), await getTestPrivateKey()),
          ).toEqual([]);
          const due =
            await requirePaymentAggregateByProviderSession(
              "cs_ledger_reversal",
            );
          expect(due.state).toBe("fully_refunded");
          expect(due.completionState).toBe("pending");
          expect(due.nextReconcileAt).not.toBeNull();

          await runDuePaymentMaintenance(due.id);

          const legs = await transfersByAccount(account);
          const refundCash = legs.find((leg) => leg.kind === "refund_cash");
          expect(refundCash?.memo).toBe("price_changed");
          expect(balanceOf(account)(legs)).toBe(0);
          expect(legs.some((leg) => leg.kind === "payment")).toBe(true);
          expect(legs.some((leg) => leg.kind === "sale")).toBe(false);
          const notes = await getNotesFor(
            attendeeNotes(attendee!.id),
            await getTestPrivateKey(),
          );
          expect(notes).toHaveLength(1);
          expect(notes[0]!.note).toContain("price changed");
          expect(notes[0]!.note).toContain(
            `/admin/ledger/attendee/${attendee!.id}`,
          );
          const completed =
            await requirePaymentAggregateByProviderSession(
              "cs_ledger_reversal",
            );
          expect(completed.state).toBe("fully_refunded");
          expect(completed.completionState).toBe("completed");
          expect(refund.calls).toHaveLength(1);
        },
      );
    });

    test("a stored-refunded booking attaches its placeholder to a terminal refund", async () => {
      const listing = await setupWithListing();
      await expectReplayOutcome(
        priceChangedSession(listing.id, "cs_unfinalized"),
        { processed: false, refundCalls: 1 },
      );
      const [attendee] = await getAttendeesRaw(listing.id);
      const payment =
        await requirePaymentAggregateByProviderSession("cs_unfinalized");
      expect(payment.attendeeId).toBe(attendee!.id);
      expect(payment.completion?.kind).toBe("placeholder_refund");
      expect(payment.state).toBe("fully_refunded");
    });

    test("a redelivery of a stored-refunded booking replays the refund — no re-create, no re-refund, no ticket", async () => {
      const listing = await setupWithListing();
      await runWebhook(
        priceChangedSession(listing.id, "cs_replay_refund"),
        async (refund) => {
          // The redelivery must replay the SAME refund outcome (processed:false), not
          // a finalized success (processed:true / a ticket) — and must not duplicate
          // the booking or re-refund. This is the exact failure an over-eager finalize
          // would cause, which the type system can't see.
          await expectDeliveryReplays(200, {
            processed: false,
            status: "fully_refunded",
          });
          expect((await getAttendeesRaw(listing.id)).length).toBe(1);
          expect(refund.calls.length).toBe(1);
        },
      );
    });

    test("a successful booking leaves completion due", async () => {
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
          const payment =
            await requirePaymentAggregateByProviderSession("cs_finalized");
          expect(payment.attendeeId).toBe(attendee!.id);
          expect(payment.state).toBe("processing");
          expect(payment.completionState).toBe("pending");
          expect(payment.nextReconcileAt).not.toBeNull();
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
      const createBooking = attendeesApi.createBookingAtomic;
      let createCalls = 0;
      const boom = stub(attendeesApi, "createBookingAtomic", (...args) => {
        createCalls += 1;
        return createCalls === 1
          ? Promise.reject(new Error("synthetic create failure"))
          : createBooking(...args);
      });
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
            const payment =
              await requirePaymentAggregateByProviderSession("cs_crash_store");
            expect(payment.completion?.kind).toBe("placeholder_refund");
            expect(payment.state).toBe("fully_refunded");
            expect(payment.completionState).toBe("pending");
            expect(createCalls).toBe(2);
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
          const payment =
            await requirePaymentAggregateByProviderSession(
              "cs_missing_listing",
            );
          expect(payment.completion?.kind).toBe("placeholder_refund");
          expect(payment.state).toBe("fully_refunded");
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
        expect(await response.text()).toContain(
          "We could not find this payment.",
        );
        expect(refund.calls.length).toBe(0);
      } finally {
        retrieve.restore();
        refund.restore();
      }
    });

    // ---- failed-refund behaviour for a stored booking -------------------------

    test("a failed stored refund replays its durable retry response", async () => {
      const listing = await setupWithListing();
      // The provider refund failed, so the stored placeholder remains due. A
      // callback redelivery replays the retry response without creating or
      // refunding it again; maintenance owns the next provider attempt.
      await runFailedRefund(
        "cs_refund_retry",
        false,
        listing.id,
        async (refund) => {
          await expectDeliveryReplays(503, { status: "retry" });
          expect(refund.calls.length).toBe(1);
          const [attendee] = await getAttendeesRaw(listing.id);
          expect(attendee?.quantity).toBe(0);
          const payment =
            await requirePaymentAggregateByProviderSession("cs_refund_retry");
          const completion = payment.completion;
          if (completion?.kind !== "placeholder_refund") {
            throw new Error("Expected placeholder refund completion");
          }
          expect(completion.result.refund?.status).toBe("failed");
          expect(completion.result.status).toBe(503);
          expect(payment.completionState).toBe("pending");
          expect(payment.nextReconcileAt).not.toBeNull();
          expect(payment.state).toBe("refunding");
        },
      );
    });
  },
);
