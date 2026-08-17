// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  adminPageHtml,
  attendeeLegsOfKind,
  sumOfAllBalances,
} from "#test/specs/support/money-reads.ts";
import { makeRefundLedgerUnavailable } from "#test/specs/support/refund-safety/faults.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  theListing,
} from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest, withExpectedError } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  checkoutSessionEvent,
  findKeptPlaceholder,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

const UNREADABLE = {
  eventId: "evt_spec_unreadable",
  paymentIntent: "pi_spec_unreadable",
  priceMinor: 500,
  sessionId: "cs_spec_unreadable",
};

/** The provider's message for a paid checkout whose charged amount is not a
 * whole number of pence — a shape the site refuses to read as a booking. */
const unreadableEvent = (
  listingId: number,
): ReturnType<typeof checkoutSessionEvent> =>
  checkoutSessionEvent({
    amountTotal: 10.5,
    eventId: UNREADABLE.eventId,
    metadata: signedMeta(
      {
        email: "unreadable@example.com",
        items: singleItem(listingId, 1, UNREADABLE.priceMinor),
        name: "Unreadable Customer",
      },
      UNREADABLE.priceMinor,
    ),
    paymentIntent: UNREADABLE.paymentIntent,
    sessionId: UNREADABLE.sessionId,
  });

/** Post the unreadable payment message through the real webhook route. The
 * route logs the rejection as an error, so the delivery runs under the
 * expected-error window. */
const deliverPaymentMessage = (world: TicketsWorld): Promise<Response> =>
  withExpectedError(async () => {
    const mockVerify = await stubWebhookVerify(
      unreadableEvent(theListing(world)),
    );
    try {
      return await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
    } finally {
      mockVerify.restore();
    }
  });

const keepAnswer = async (
  world: TicketsWorld,
  response: Response,
): Promise<void> => {
  world.firstStatus = response.status;
  world.firstBody = await response.text();
};

Given(
  "a paid checkout arrives in a form the site cannot read",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: UNREADABLE.priceMinor,
    });
    this.listingId = listing.id;
    this.sessionId = UNREADABLE.sessionId;
    const refund = stubRefundPayment(
      "re_spec_unreadable",
      UNREADABLE.priceMinor,
    );
    this.cleanup.add(() => refund.restore());
    this.refundCalls = () => refund.calls.length;
  },
);

When(
  "the payment message is delivered",
  // Deliveries retry a contended file lock for up to a few seconds, so give
  // them headroom over the five-second default rather than failing mid-retry.
  { timeout: 15_000 },
  async function (this: TicketsWorld): Promise<void> {
    await keepAnswer(this, await deliverPaymentMessage(this));
  },
);

When(
  "the same payment message is delivered again",
  { timeout: 15_000 },
  async function (this: TicketsWorld): Promise<void> {
    await keepAnswer(this, await deliverPaymentMessage(this));
  },
);

Given(
  "the money records are temporarily failing to save",
  async function (this: TicketsWorld): Promise<void> {
    this.moneyFault = await makeRefundLedgerUnavailable(this.cleanup);
  },
);

Given(
  "the payment message fails on delivery",
  { timeout: 15_000 },
  async function (this: TicketsWorld): Promise<void> {
    // The refund goes back, the kept booking is stored, and then the money
    // records refuse to save — so the delivery fails and the provider will
    // send the same message again.
    const response = await deliverPaymentMessage(this);
    expect(response.status).toBe(503);
  },
);

When(
  "the money records recover and the message is delivered again",
  { timeout: 15_000 },
  async function (this: TicketsWorld): Promise<void> {
    await requiredWorldValue(this.moneyFault, "money records fault").restore();
    await keepAnswer(this, await deliverPaymentMessage(this));
  },
);

Then(
  "the message is answered as settled without a ticket",
  function (this: TicketsWorld): void {
    const body = requiredWorldValue(this.firstBody, "webhook answer");
    // Status and body together: a failure names which answer came back
    // instead of only showing a bare status number.
    expect({ body, status: this.firstStatus }).toMatchObject({ status: 200 });
    expect(JSON.parse(body) as Record<string, unknown>).toMatchObject({
      error: "rejected",
      processed: false,
      received: true,
    });
  },
);

Then(
  "the customer is kept as a booking with no ticket",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = theListing(this);
    const attendee = await findKeptPlaceholder(listingId);
    this.placeholderId = attendee.id;
    // The kept booking is the only record — a repeat delivery must not have
    // added a second customer of any kind.
    expect((await getAttendeesRaw(listingId)).length).toBe(1);
  },
);

Then(
  "the money is handed back exactly once",
  function (this: TicketsWorld): void {
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(1);
  },
);

Then(
  "the organiser can read why the payment was returned",
  async function (this: TicketsWorld): Promise<void> {
    const attendeeId = requiredWorldValue(this.placeholderId, "kept booking");
    const notes = await getNotesFor(
      attendeeNotes(attendeeId),
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toContain(
      "the provider reported the payment in a form the site could not read",
    );
    expect(notes[0]?.note).toContain("Refund code: malformed_charge");
    expect(notes[0]?.note).toContain(`/admin/ledger/attendee/${attendeeId}`);
    expect(notes[0]?.note).not.toContain(UNREADABLE.paymentIntent);
  },
);

Then(
  "the books show the payment and its return in balance",
  async function (this: TicketsWorld): Promise<void> {
    const attendeeId = requiredWorldValue(this.placeholderId, "kept booking");
    const payments = await attendeeLegsOfKind(attendeeId, "payment");
    expect(payments.map((leg) => leg.amount)).toEqual([UNREADABLE.priceMinor]);
    const returns = await attendeeLegsOfKind(attendeeId, "refund_cash");
    expect(returns.map((leg) => leg.amount)).toEqual([UNREADABLE.priceMinor]);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Then(
  "no returned payment is waiting in refund recovery",
  async function (this: TicketsWorld): Promise<void> {
    expect(await adminPageHtml("/admin/privacy")).not.toContain("Open refund ");
  },
);
