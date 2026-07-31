import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { signBalanceToken } from "#shared/balance-link.ts";
import { requirePaidDefaultStatus } from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import type { stripeApi } from "#shared/stripe.ts";
import {
  createNonReservationAttendee,
  createReservedAttendee,
} from "#test-utils/balance.ts";
import { signMeta, webhookMeta } from "#test-utils/factories.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { testCsrfToken } from "#test-utils/session.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

/** A settle identity (session id + business time) for settleAttendeeBalance. */
export const settle = (id = "settle-session") => ({
  id,
  occurredAt: "2026-06-21T00:00:00.000Z",
});

/** POST a pay form for a token as the customer. */
export const postPay = async (token: string): Promise<Response> =>
  handleRequest(
    mockFormRequest(`/pay/${token}`, { csrf_token: await testCsrfToken() }, ""),
  );

/** Insert a bare attendee row (no bookings) with a status and balance. */
export const insertBareAttendee = async (
  statusId: number | null,
  remainingBalance: number,
): Promise<number> => {
  // A current `created` keeps this bare (booking-less) attendee out of the
  // orphaned-record auto-purge, which reaps orphans older than the retention.
  const inserted = await getDb().execute({
    args: [new Date().toISOString(), statusId],
    sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
  });
  const attendeeId = Number(inserted.lastInsertRowid);
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
export const createReserved = async (
  remainingBalance: number,
): Promise<number> =>
  (
    await createReservedAttendee(remainingBalance, {
      listingName: "Workshop Ticket",
      quantity: 2,
    })
  ).attendeeId;

/** Create a non-reservation attendee owing a balance on a real booking line. */
export const createNonReservation = async (
  remainingBalance: number,
): Promise<number> =>
  (
    await createNonReservationAttendee(remainingBalance, {
      listingName: "Workshop Ticket",
    })
  ).attendeeId;

/** Assert the pay page rendered the recap: title, listing name and amount due. */
export const expectRecap = (html: string): void => {
  expect(html).toContain("Pay your balance");
  expect(html).toContain("Workshop Ticket");
  expect(html).toContain("Balance due");
};

/** GET /pay for an attendee's signed token; assert 200 and return the html. */
export const getPayPage = async (attendeeId: number): Promise<string> => {
  const token = await signBalanceToken(attendeeId);
  const response = await handleRequest(mockRequest(`/pay/${token}`));
  expect(response.status).toBe(200);
  return response.text();
};

/**
 * A signed Stripe balance-payment checkout session for `attendeeId`.
 * `signedAmount` is the proof/items total; `chargedAmount` (defaults to it) is
 * what the provider reports in `amount_total`. `over` merges into the session and
 * `meta` into its metadata (e.g. a tampered price_proof); payment_intent mirrors
 * the id with cs_→pi_.
 */
export const balanceSession = (
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

/** Stand in for both reads a paid balance session needs. */
export const stubBalanceSession = (
  ...args: Parameters<typeof balanceSession>
) => {
  const session = balanceSession(...args) as unknown as {
    amount_total: number;
    created?: number;
    id: string;
    metadata: Record<string, unknown>;
    payment_intent: string;
  };
  return stubRetrieveCheckoutSession({
    amountTotal: session.amount_total,
    ...(session.created === undefined ? {} : { created: session.created }),
    metadata: session.metadata,
    paymentIntent: session.payment_intent,
    sessionId: session.id,
  });
};

/** Drive the success webhook for `sessionId` and assert it cleared the balance
 * and flipped the attendee onto the paid default status. */
export const expectSettled = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  const paid = await requirePaidDefaultStatus();
  const response = await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
  expect(response.status).toBe(200);
  const state = await getAttendeeBalanceState(attendeeId);
  expect(state?.remainingBalance).toBe(0);
  expect(state?.statusId).toBe(paid!.id);
};
