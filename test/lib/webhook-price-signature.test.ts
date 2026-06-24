import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { getNoteRows, getNotesForAttendee } from "#shared/db/system-notes.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
  mockRequest,
  mockWebhookRequest,
  setupStripe,
  signMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

/**
 * The three-verdict trust model. A paid session's price proof is the ONLY signal
 * that it is ours: it cannot be forged without our signing key, and our checkout
 * always attaches one, so the unsigned `_origin` marker plays no part. Every
 * session classifies as exactly one of:
 *
 *  - trusted  (valid proof, charge == signed total): processed.
 *  - mismatch (valid proof, charge != signed total): a payment we signed, so it
 *             is never dropped — the booking is KEPT as a quantity-0 placeholder,
 *             refunded, and flagged with a system note.
 *  - ignore   (no valid proof — absent, malformed, tampered, or foreign):
 *             acknowledged without processing or refunding (we can't prove it is
 *             ours, and refunding an unverifiable session could refund another
 *             instance's payment).
 *
 * These tests drive every verdict through the real webhook/redirect entrypoints,
 * plus the failed-refund behaviour a stored booking depends on.
 */

/** Build signed metadata for a single-line ticket checkout. */
const signedMeta = (
  total: number,
  fields: {
    items: string;
    name?: string;
    email?: string;
    modifiers?: string;
  },
): Record<string, string> =>
  signMeta(
    webhookMeta({
      email: "buyer@example.com",
      name: "Buyer",
      ...fields,
    }),
    total,
  );

/** Stub the Stripe provider to return a completed (paid) checkout session. */
const stubCompletedSession = async (object: {
  amount_total: number;
  id: string;
  metadata: Record<string, string>;
}) => {
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  return stub(stripePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({
      listing: {
        data: {
          object: {
            ...object,
            payment_intent: `pi_${object.id}`,
            payment_status: "paid",
          },
        },
        id: `evt_${object.id}`,
        type: "checkout.session.completed",
      },
      valid: true as const,
    }),
  );
};

/** Stub the redirect path's session retrieval for a paid session. */
const stubRetrievedSession = (object: {
  amount_total: number;
  id: string;
  metadata: Record<string, string>;
}) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      ...object,
      payment_intent: `pi_${object.id}`,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );

const webhookRequest = () =>
  handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

const redirectRequest = (id: string) =>
  handleRequest(mockRequest(`/payment/success?session_id=${id}`));

/** Stub the provider refund to succeed (deterministic — no network). */
const stubRefundOk = () =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: "re_ok" } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

/** setupStripe + a 50-seat listing priced at 1000. */
const setupWithListing = async () => {
  await setupStripe();
  return createTestListing({ maxAttendees: 50, unitPrice: 1000 });
};

/** Drive a completed (paid) session through the webhook with a refund stub
 *  installed; `body` receives the refund spy. All stubs are restored after. */
const runWebhook = async (
  session: {
    id: string;
    metadata: Record<string, string>;
    amount_total?: number;
  },
  body: (refund: ReturnType<typeof stubRefundOk>) => Promise<void>,
): Promise<void> => {
  const refund = stubRefundOk();
  const mockVerify = await stubCompletedSession({
    amount_total: session.amount_total ?? 1000,
    id: session.id,
    metadata: session.metadata,
  });
  try {
    await body(refund);
  } finally {
    mockVerify.restore();
    refund.restore();
  }
};

/** Drive a mismatch (charged 1200, signed 1000) whose refund returns null, with
 *  the payment intent's refunded state stubbed; `body` receives the refund spy. */
const runFailedRefund = async (
  id: string,
  intentRefunded: boolean,
  listingId: number,
  body: (refund: ReturnType<typeof stubRefundOk>) => Promise<void>,
): Promise<void> => {
  const refund = stub(stripeApi, "refundPayment", () => Promise.resolve(null));
  const intent = stub(stripeApi, "retrievePaymentIntent", () =>
    Promise.resolve({
      latest_charge: { refunded: intentRefunded },
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrievePaymentIntent>
    >),
  );
  const mockVerify = await stubCompletedSession({
    amount_total: 1200,
    id,
    metadata: signedMeta(1000, { items: singleItem(listingId, 1, 1000) }),
  });
  try {
    await body(refund);
  } finally {
    mockVerify.restore();
    intent.restore();
    refund.restore();
  }
};

/** Assert the webhook kept the booking as a quantity-0 placeholder (with a system
 *  note) and refused with the generic "saved your details" message. */
const expectStoredRefund = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(false);
    expect(json.error).toContain("saved your details");
  });
  const [attendee] = await getAttendeesRaw(listingId);
  expect(attendee?.quantity).toBe(0);
  expect(await getNoteRows([attendee!.id])).toHaveLength(1);
};

/** Assert the webhook acknowledges (200) and silently ignores the session. */
const expectAcknowledgedIgnore = () =>
  assertJson(webhookRequest(), 200, (json) => {
    expect(json.received).toBe(true);
    expect(json.processed).toBeUndefined();
  });

/** Assert no attendee rows were created for the listing. */
const expectNoAttendees = async (listingId: number): Promise<void> => {
  expect((await getAttendeesRaw(listingId)).length).toBe(0);
};

/** Assert the webhook processed the session and created exactly one attendee. */
const expectProcessed = async (listingId: number): Promise<void> => {
  await assertJson(webhookRequest(), 200, (json) => {
    expect(json.processed).toBe(true);
  });
  expect((await getAttendeesRaw(listingId)).length).toBe(1);
};

describeWithEnv("webhook signed price oracle", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  // ---- trusted: process -----------------------------------------------------

  test("a faithfully signed session is processed and creates the attendee", async () => {
    const listing = await setupWithListing();
    await runWebhook(
      {
        id: "cs_signed_ok",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      },
      () => expectProcessed(listing.id),
    );
  });

  test("a signed session whose _origin was stripped is still processed", async () => {
    const listing = await setupWithListing();
    // _origin is unsigned, so stripping it after signing leaves a valid proof.
    // The proof alone proves the session is ours, regardless of the origin.
    const metadata = {
      ...signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      _origin: "",
    };
    await runWebhook({ id: "cs_origin_stripped", metadata }, () =>
      expectProcessed(listing.id),
    );
  });

  // ---- mismatch / divergence: store a quantity-0 placeholder, refund, flag ---

  test("a charge that differs from the signed total is stored and refunded", async () => {
    const listing = await setupWithListing();
    // Signed at 1000 but the provider reports a 1200 charge — a mismatch. The
    // payment is ours (signed), so the booking is kept (not dropped into limbo).
    await runWebhook(
      {
        amount_total: 1200,
        id: "cs_signed_mismatch",
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      },
      async (refund) => {
        await expectStoredRefund(listing.id);
        expect(refund.calls.length).toBe(1);
      },
    );
  });

  test("a re-derivation that diverges from the signed total is stored and refunded", async () => {
    const listing = await setupWithListing();
    // Signed and charged at 999, but the item re-prices to 1000 — a price edit
    // between checkout and webhook. The booking is kept, refunded, and flagged.
    await runWebhook(
      {
        amount_total: 999,
        id: "cs_signed_diverge",
        metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
      },
      async (refund) => {
        await expectStoredRefund(listing.id);
        expect(refund.calls.length).toBe(1);
      },
    );
  });

  test("a divergence from a dropped modifier ref is stored and refunded", async () => {
    const listing = await setupWithListing();
    // Signed at 1100 as if a +100 modifier applied, but the referenced modifier
    // no longer resolves, so re-derivation lands at 1000 — stored and refunded.
    const metadata = signedMeta(1100, {
      items: singleItem(listing.id, 1, 1000),
      modifiers: JSON.stringify([{ i: 999999, q: 1 }]),
    });
    await runWebhook(
      { amount_total: 1100, id: "cs_signed_dropped", metadata },
      async (refund) => {
        await expectStoredRefund(listing.id);
        expect(refund.calls.length).toBe(1);
      },
    );
  });

  test("stores the booking, reverses the ledger with the reason code, and flags it", async () => {
    const listing = await setupWithListing();
    // Signed and charged at 999, but the live price is 1000 — a mid-checkout edit.
    await runWebhook(
      {
        amount_total: 999,
        id: "cs_ledger_reversal",
        metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
      },
      async () => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
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
        const notes = await getNotesForAttendee(
          attendee!.id,
          await getTestPrivateKey(),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]!.note).toContain("price changed");
        expect(notes[0]!.note).toContain(
          `/admin/ledger/attendee/${attendee!.id}`,
        );
      },
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
    await runWebhook(
      {
        amount_total: 999,
        id: "cs_unfinalized",
        metadata: signedMeta(999, { items: singleItem(listing.id, 1, 1000) }),
      },
      async () => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        // The booking exists in the diary…
        expect((await getAttendeesRaw(listing.id)).length).toBe(1);
        // …but the session is NOT finalized: attendee_id stays null and the refund
        // is the terminal outcome. If a change finalizes it, a replay would wrongly
        // hand the customer a ticket — so pin both fields.
        const record = await isSessionProcessed("cs_unfinalized");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      },
    );
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
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        // The redelivery must replay the SAME refund outcome (processed:false), not
        // a finalized success (processed:true / a ticket) — and must not duplicate
        // the booking or re-refund. This is the exact failure an over-eager finalize
        // would cause, which the type system can't see.
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
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
        metadata: signedMeta(1000, { items: singleItem(listing.id, 1, 1000) }),
      },
      async () => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(true);
        });
        const [attendee] = await getAttendeesRaw(listing.id);
        // A success finalizes (attendee_id set in the same transaction as the
        // attendee insert), so its replay returns the ticket. The store-refund path
        // is the deliberate exception above; keep the two from drifting together.
        const record = await isSessionProcessed("cs_finalized");
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
    const { attendeesApi } = await import("#shared/db/attendees.ts");
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
          const record = await isSessionProcessed("cs_crash_store");
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
        const record = await isSessionProcessed("cs_missing_listing");
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
    const retrieve = stubRetrievedSession({
      amount_total: 1000,
      id: "cs_foreign_redirect",
      metadata,
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
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        // A second delivery replays the recorded outcome — it does not re-create the
        // attendee or re-attempt the (now operator-owned) refund.
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        expect(refund.calls.length).toBe(1);
        const [attendee] = await getAttendeesRaw(listing.id);
        expect(attendee?.quantity).toBe(0);
        expect(await getNoteRows([attendee!.id])).toHaveLength(1);
        const record = await isSessionProcessed("cs_refund_retry");
        expect(record?.failure_data).not.toBe("");
      },
    );
  });

  test("a mismatch whose refund reports failure but already settled is acknowledged", async () => {
    const listing = await setupWithListing();
    // The refund call returns null (e.g. the provider rejected a second full
    // refund), but the payment IS already fully refunded. That is success, not a
    // 503 retry loop: acknowledge and record the terminal outcome.
    await runFailedRefund(
      "cs_already_refunded",
      true,
      listing.id,
      async (refund) => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(false);
        });
        expect(refund.calls.length).toBe(1);
        // Recorded as a terminal failure (refund settled), so a later delivery
        // replays it instead of retrying.
        const record = await isSessionProcessed("cs_already_refunded");
        expect(record?.failure_data).not.toBe("");
      },
    );
  });
});
