import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { signBalanceToken } from "#shared/balance-link.ts";
import {
  attendeeStatusesTable,
  getPaidDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  settleAttendeeBalance,
} from "#shared/db/attendees/balance.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { execute, getDb } from "#shared/db/client.ts";
import { prunePayments } from "#shared/db/prune.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createTestListing,
  describeWithEnv,
  mockFormRequest,
  mockRequest,
  setupStripe,
  signMeta,
  testCsrfToken,
  webhookMeta,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

/** A settle identity (session id + business time) for settleAttendeeBalance. */
const settle = (id = "settle-session") => ({
  id,
  occurredAt: "2026-06-21T00:00:00.000Z",
});

/** POST a pay form for a token as the customer. */
const postPay = async (token: string): Promise<Response> =>
  handleRequest(
    mockFormRequest(`/pay/${token}`, { csrf_token: await testCsrfToken() }, ""),
  );

/** Insert a bare attendee row (no bookings) with a status and balance. */
const insertBareAttendee = async (
  statusId: number | null,
  remainingBalance: number,
): Promise<number> => {
  // A current `created` keeps this bare (booking-less) attendee out of the
  // orphaned-record auto-purge, which reaps orphans older than the retention.
  await getDb().execute({
    args: [new Date().toISOString(), statusId],
    sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
  });
  const { rows } = await getDb().execute(
    "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
  );
  const attendeeId = Number(rows[0]!.id);
  // Outstanding balance projects from the ledger: owe `remainingBalance` via a
  // sale leg to a listing with no booking row, nothing paid.
  if (remainingBalance > 0) {
    await postListingSale({
      amountPaid: 0,
      attendeeId,
      gross: remainingBalance,
      listingId: 98765,
    });
  }
  return attendeeId;
};

/** Create a reserved attendee with an outstanding balance and a paid listing. */
const createReserved = async (remainingBalance: number) => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: "Workshop Ticket",
    thankYouUrl: "https://example.com",
  });
  const reservation = await attendeeStatusesTable.insert({
    isReservation: true,
    name: "Reserved",
    reservationAmount: "10%",
  });
  const result = await createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 100, quantity: 2 }],
    email: "guest@example.com",
    name: "Guest",
    remainingBalance,
    statusId: reservation.id,
  });
  if (!result.success) throw new Error("setup failed");
  const attendeeId = result.attendees[0]!.id;
  // Owe `remainingBalance` in the ledger: gross sale (deposit + remaining) plus
  // the £1 deposit payment, so balanceOf nets to −remainingBalance.
  await postListingSale({
    amountPaid: 100,
    attendeeId,
    gross: 100 + remainingBalance,
    listingId: listing.id,
  });
  return attendeeId;
};

/**
 * A signed Stripe balance-payment checkout session for `attendeeId`.
 * `signedAmount` is the proof/items total; `chargedAmount` (defaults to it) is
 * what the provider reports in `amount_total`. `over` merges into the session and
 * `meta` into its metadata (e.g. a tampered price_proof); payment_intent mirrors
 * the id with cs_→pi_.
 */
const balanceSession = (
  attendeeId: number,
  signedAmount: number,
  id: string,
  {
    chargedAmount = signedAmount,
    eventId = 1,
    over = {},
    meta = {},
  }: {
    chargedAmount?: number;
    eventId?: number;
    over?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  } = {},
) =>
  ({
    amount_total: chargedAmount,
    id,
    metadata: {
      ...signMeta(
        webhookMeta({
          balance_attendee_id: String(attendeeId),
          items: JSON.stringify([{ e: eventId, p: signedAmount, q: 1 }]),
          name: "Balance payment",
        }),
        signedAmount,
      ),
      ...meta,
    },
    payment_intent: id.replace(/^cs_/, "pi_"),
    payment_status: "paid",
    ...over,
  }) as unknown as Awaited<
    ReturnType<typeof stripeApi.retrieveCheckoutSession>
  >;

/** Stub retrieveCheckoutSession to return a {@link balanceSession}. */
const stubBalanceSession = (...args: Parameters<typeof balanceSession>) =>
  stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve(balanceSession(...args)),
  );

/** Drive the success webhook for `sessionId` and assert it cleared the balance
 * and flipped the attendee onto the paid default status. */
const expectSettled = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  const paid = await getPaidDefaultStatus();
  const response = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  expect(response.status).toBe(200);
  const state = await getAttendeeBalanceState(attendeeId);
  expect(state?.remainingBalance).toBe(0);
  expect(state?.statusId).toBe(paid!.id);
};

describeWithEnv("server (public balance page)", { db: true }, () => {
  afterEach(() => resetStripeClient());

  test("GET shows the recap and balance due for a reserved attendee", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(mockRequest(`/pay/${token}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Pay your balance");
    expect(html).toContain("Workshop Ticket");
    expect(html).toContain("Balance due");
    // No PII (the booker's name) is shown.
    expect(html).not.toContain("Guest");
  });

  test("GET shows a settled message once the balance is cleared", async () => {
    const attendeeId = await createReserved(1500);
    await settleAttendeeBalance(attendeeId, 1500, settle());
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(mockRequest(`/pay/${token}`));
    const html = await response.text();
    expect(html).toContain("Nothing to pay");
  });

  test("GET rejects an invalid token", async () => {
    const response = await handleRequest(mockRequest("/pay/bal1.bogus.bogus"));
    const html = await response.text();
    expect(html).toContain("not valid");
  });

  test("GET rejects a validly-signed token for a missing attendee", async () => {
    // The token verifies, but no attendee row matches, so the balance state is
    // null. The handler must short-circuit to the not-valid page rather than
    // dereference the absent state.
    const token = await signBalanceToken(999_999);
    const response = await handleRequest(mockRequest(`/pay/${token}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not valid");
  });

  test("GET treats a balance with no status as settled", async () => {
    const attendeeId = await insertBareAttendee(null, 1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(mockRequest(`/pay/${token}`));
    expect(await response.text()).toContain("Nothing to pay");
  });

  test("GET refuses a reserved balance whose only line is no-quantity", async () => {
    const attendeeId = await createReserved(1500);
    // Turn the only line into a no-quantity sentinel: nothing real to pay into.
    await getDb().execute({
      args: [attendeeId],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
    });
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(mockRequest(`/pay/${token}`));
    expect(await response.text()).toContain("not valid");
  });

  test("POST refuses a reservation with no real booking line", async () => {
    await setupStripe();
    const reservation = await attendeeStatusesTable.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10%",
    });
    // No quantity > 0 line means nothing real to pay into, so the balance is not
    // publicly payable — checkout must not start against a phantom listing.
    const attendeeId = await insertBareAttendee(reservation.id, 1500);
    const token = await signBalanceToken(attendeeId);
    const response = await postPay(token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not valid");
  });

  test("POST rejects an invalid csrf token", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "invalid" }, ""),
    );
    expect(await response.text()).toContain("not valid");
  });

  test("POST starts a checkout for the balance", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(
        `/pay/${token}`,
        { csrf_token: await testCsrfToken() },
        "",
      ),
    );
    // Redirects to the hosted checkout (302/303) on success.
    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toContain("http");
  });

  test("POST rejects an invalid CSRF token before checkout", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "wrong-token" }, ""),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not valid");
  });

  test("POST shows an error when no payment provider is configured", async () => {
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await postPay(token);
    expect(await response.text()).toContain("not valid");
  });

  test("POST rejects an invalid CSRF token before checking the balance", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const response = await handleRequest(
      mockFormRequest(`/pay/${token}`, { csrf_token: "bad-token" }, ""),
    );
    expect(await response.text()).toContain("not valid");
  });

  test("POST shows an error when the checkout cannot be created", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const token = await signBalanceToken(attendeeId);
    const checkoutStub = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      () => Promise.resolve({ error: "boom" }),
    );
    try {
      const response = await postPay(token);
      expect(await response.text()).toContain("not valid");
    } finally {
      checkoutStub.restore();
    }
  });

  test("an unsigned balance webhook is ignored, leaving the balance outstanding", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // No price proof: we cannot prove this balance session is ours, so it is
    // ignored — neither settled nor refunded.
    const session = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1500,
        id: "cs_balance_unsigned",
        metadata: {
          balance_attendee_id: String(attendeeId),
          items: JSON.stringify([{ e: 1, p: 1500, q: 1 }]),
          name: "Balance payment",
        },
        payment_intent: "pi_balance",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_unsigned"),
      );
      expect(await response.text()).toContain("not recognized");
      // The balance is untouched — nothing was settled.
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
    }
  });

  test("the webhook settles a signed balance checkout", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const session = stubBalanceSession(attendeeId, 1500, "cs_balance_signed");
    try {
      await expectSettled("cs_balance_signed", attendeeId);
    } finally {
      session.restore();
    }
  });

  test("a pruned balance replay is recovered, not refunded", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // First delivery settles the balance and posts its payment leg.
    const first = stubBalanceSession(attendeeId, 1500, "cs_balance_replay");
    try {
      await expectSettled("cs_balance_replay", attendeeId);
    } finally {
      first.restore();
    }

    // Prune the idempotency row; the balance payment leg stays in the ledger.
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2000-01-01T00:00:00.000Z", "cs_balance_replay"],
    );
    await prunePayments();

    // The replay: the balance is already paid (owed 0), so without the ledger
    // preflight settleAttendeeBalance reports nothing_owed and refunds the
    // already-paid customer. The preflight replays success instead.
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_x" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const second = stubBalanceSession(attendeeId, 1500, "cs_balance_replay");
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_replay"),
      );
      expect(response.status).toBe(200);
      expect(refund.calls.length).toBe(0);
      // Balance stays cleared; nothing re-settled or refunded.
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);
    } finally {
      second.restore();
      refund.restore();
    }
  });

  test("posts a balance payment leg once the booking is in the ledger", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // createReserved already dual-wrote the booking, leaving the attendee owing
    // 1500 in the ledger (a 1600 sale funded by a 100 deposit).
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(-1500);
    // Stripe stamps `created` (Unix seconds) when the checkout is made; the
    // balance-payment leg should be dated from it, not from processing time.
    const created = Math.floor(Date.parse("2026-06-20T09:00:00.000Z") / 1000);
    const session = stubBalanceSession(attendeeId, 1500, "cs_balance_ledger", {
      over: { created },
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_ledger"),
      );
      expect(response.status).toBe(200);
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);
      // The balance payment leg cleared the ledger balance too.
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
      // …and it carries the checkout's business time, not the processing clock.
      const legs = await transfersByAccount(attendeeAccount(attendeeId));
      const balancePayment = legs.find(
        (leg) => leg.kind === "payment" && leg.amount === 1500,
      );
      expect(balancePayment?.occurredAt).toBe(
        new Date(created * 1000).toISOString(),
      );
    } finally {
      session.restore();
    }
  });

  test("a balance checkout with a tampered signature is ignored, not settled", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_bal" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    // Valid total, wrong digest — an invalid proof, so the session is ignored:
    // not settled, and not refunded (we can't prove it is ours).
    const session = stubBalanceSession(
      attendeeId,
      1500,
      "cs_balance_tampered",
      {
        meta: { price_proof: `1500.${"A".repeat(44)}` },
      },
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_tampered"),
      );
      // Ignored: the balance is left outstanding and no refund was issued.
      expect(refund.calls.length).toBe(0);
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
      refund.restore();
    }
  });

  test("settles the balance even when the booking's listing has since been deleted", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_nolisting", {
      eventId: 98765,
    });
    try {
      // The balance settlement is the operation that matters; a missing listing
      // only means no thank-you URL, so the session still finalizes (no stuck
      // unfinalized reservation after the customer has paid).
      await expectSettled("cs_bal_nolisting", attendeeId);
    } finally {
      session.restore();
    }
  });

  test("refunds and does not settle when the balance changed after checkout", async () => {
    await setupStripe();
    // The customer's checkout was created for 1500, but the owner has since
    // lowered the live balance to 500. The stale 1500 callback must refund and
    // leave the balance untouched rather than clear the wrong amount.
    const attendeeId = await createReserved(500);
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_bal" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_stale");
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_stale"),
      );
      // The stale payment is refunded, not applied.
      expect(refund.calls[0]!.args).toEqual(["pi_bal_stale"]);
      const html = await response.text();
      expect(html).toContain("balance for this booking changed");
      // The live balance is untouched — still outstanding.
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(500);
    } finally {
      session.restore();
      refund.restore();
    }
  });

  test("refunds when the provider charged a different amount than the checkout", async () => {
    await setupStripe();
    // The checkout was signed for 1500, but the provider reports charging only
    // 1000 — a charge/signed-total mismatch, refunded before any settlement.
    const attendeeId = await createReserved(1500);
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_amt" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_amt", {
      chargedAmount: 1000,
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_amt"),
      );
      expect(refund.calls[0]!.args).toEqual(["pi_bal_amt"]);
      expect(await response.text()).toContain("price for this listing changed");
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
      refund.restore();
    }
  });

  test("non-matching /pay requests fall through", async () => {
    // The bare prefix and an unsupported method are not handled here (→ not 200).
    expect((await handleRequest(mockRequest("/pay"))).status).not.toBe(200);
    expect((await handleRequest(mockRequest("/pay/"))).status).not.toBe(200);
    const del = await handleRequest(
      new Request("http://localhost/pay/bal1.x.y", { method: "DELETE" }),
    );
    expect(del.status).not.toBe(200);
  });
});
