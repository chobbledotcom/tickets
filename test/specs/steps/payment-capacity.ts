// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getPaymentSessionByResourceOrNull } from "#shared/db/payments/sessions.ts";
import { getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { fillSoleCapacityListing } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
import { mockRequest, withExpectedError } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectAttendeeCreatedWithPiiBlob,
  expectRefundedWithNote,
  expectSessionFailed,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
  findKeptPlaceholder,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

const availableSession = {
  eventId: "evt_spec_available",
  name: "Available Customer",
  paymentIntent: "pi_spec_available",
  sessionId: "cs_spec_available",
};

const lateSession = {
  eventId: "evt_spec_late",
  name: "Late Customer",
  paymentIntent: "pi_spec_late",
  sessionId: "cs_spec_late",
};

const paymentEvent = (
  listingId: number,
  session: typeof availableSession,
): ReturnType<typeof checkoutSessionEvent> =>
  checkoutSessionEvent({
    amountTotal: 1000,
    eventId: session.eventId,
    metadata: signedMeta(
      {
        email: `${session.name.toLowerCase().replaceAll(" ", ".")}@example.com`,
        items: singleItem(listingId, 1, 1000),
        name: session.name,
      },
      1000,
    ),
    paymentIntent: session.paymentIntent,
    sessionId: session.sessionId,
  });

const setSoldOutListing = async (world: TicketsWorld): Promise<void> => {
  await setupStripe();
  const listing = await fillSoleCapacityListing();
  world.listingId = listing.id;
};

const returnedPayment = (sessionId: string): Promise<Response> =>
  withExpectedError(() =>
    handleRequest(mockRequest(`/payment/success?session_id=${sessionId}`)),
  );

const storedPayment = (sessionId: string) =>
  getPaymentSessionByResourceOrNull({
    id: sessionId,
    kind: "stripe_checkout_session",
    provider: "stripe",
  });

Given(
  "a paid listing has one place left",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    this.listingId = listing.id;
    this.sessionId = availableSession.sessionId;
  },
);

When(
  "a customer payment is confirmed",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "listing id");
    await expectWebhookProcessed(paymentEvent(listingId, availableSession));
  },
);

Then(
  "the customer receives a ticket",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "listing id");
    const sessionId = requiredWorldValue(this.sessionId, "session id");
    const attendee = await expectAttendeeCreatedWithPiiBlob(listingId);
    const record = await storedPayment(sessionId);
    if (!record)
      throw new Error(`Processed payment ${sessionId} was not stored`);
    expect(record.attendeeId).toBe(attendee.id);
    expect(record.ticketTokens).not.toBeNull();
  },
);

Given(
  "a paid listing became full while a customer paid",
  async function (this: TicketsWorld): Promise<void> {
    await setSoldOutListing(this);
    this.sessionId = lateSession.sessionId;
  },
);

When(
  "the late payment confirmation arrives",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "listing id");
    const { mockRefund } = await withExpectedError(() =>
      expectWebhookKeptAndRefunded(paymentEvent(listingId, lateSession)),
    );
    this.refundCalls = () => mockRefund.calls.length;
  },
);

Then(
  "the late customer is kept without a quantity",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "listing id");
    const attendee = await findKeptPlaceholder(listingId);
    this.placeholderId = attendee.id;
    expect((await getAttendeesRaw(listingId)).length).toBe(2);
  },
);

Then("the late payment is refunded once", function (this: TicketsWorld): void {
  expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(1);
});

Then(
  "the organiser can see why the booking failed",
  async function (this: TicketsWorld): Promise<void> {
    const attendeeId = requiredWorldValue(this.placeholderId, "placeholder id");
    const sessionId = requiredWorldValue(this.sessionId, "session id");
    // The note is written by the scheduled work that finishes a refunded
    // booking, moments after the customer is answered. Run it first, the way
    // the site does, or the organiser's page is read too early.
    await settleDeferredPaymentWork();
    const notes = await getNotesFor(
      attendeeNotes(attendeeId),
      await getTestPrivateKey(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toContain(
      "the event filled up while they were paying",
    );
    expect(notes[0]?.note).toContain(lateSession.paymentIntent);
    expect(notes[0]?.note).toContain(`/admin/ledger/attendee/${attendeeId}`);
    await expectSessionFailed(sessionId);
  },
);

Given(
  "a late paid booking was already kept and refunded",
  async function (this: TicketsWorld): Promise<void> {
    await setSoldOutListing(this);
    const listingId = requiredWorldValue(this.listingId, "listing id");
    const sessionId = "cs_spec_replay";
    const refund = stubRefundPayment();
    const retrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "replay@example.com",
      items: singleItem(listingId, 1, 1000),
      name: "Replay Customer",
      paymentIntent: "pi_spec_replay",
      sessionId,
    });
    this.cleanup.push(
      () => retrieve.restore(),
      () => refund.restore(),
    );
    this.refundCalls = () => refund.calls.length;
    this.sessionId = sessionId;

    const response = await returnedPayment(sessionId);
    this.firstStatus = response.status;
    this.firstBody = await response.text();
    const attendee = await findKeptPlaceholder(listingId);
    this.placeholderId = attendee.id;
    this.attendeeIds = (await getAttendeesRaw(listingId)).map(({ id }) => id);
    // Let the scheduled work finish the refunded booking before reading what
    // was filed, so the record compared against the replay is the settled one.
    await expectRefundedWithNote(attendee.id, refund);
    const record = await storedPayment(sessionId);
    if (record?.state !== "fully_refunded")
      throw new Error("terminal refund was not stored");
    this.firstFailureData = JSON.stringify(record.completion);
  },
);

When(
  "the same payment confirmation arrives again",
  async function (this: TicketsWorld): Promise<void> {
    const sessionId = requiredWorldValue(this.sessionId, "session id");
    const response = await returnedPayment(sessionId);
    this.secondStatus = response.status;
    this.secondBody = await response.text();
  },
);

Then(
  "no second customer record is made",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "listing id");
    expect((await getAttendeesRaw(listingId)).map(({ id }) => id)).toEqual(
      requiredWorldValue(this.attendeeIds, "attendee ids"),
    );
  },
);

Then("no second refund is sent", function (this: TicketsWorld): void {
  expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(1);
});

Then(
  "the same final result is returned",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.secondStatus).toBe(this.firstStatus);
    expect(this.secondStatus).toBe(200);
    const firstBody = requiredWorldValue(this.firstBody, "first body");
    const secondBody = requiredWorldValue(this.secondBody, "second body");
    expect(secondBody).toBe(firstBody);
    expect(firstBody).toContain("saved your details");
    expect(firstBody).toContain("refunded");
    expect(firstBody).not.toContain("being processed");
    const sessionId = requiredWorldValue(this.sessionId, "session id");
    const record = await storedPayment(sessionId);
    if (!record)
      throw new Error(`Processed payment ${sessionId} was not stored`);
    expect(record.attendeeId).toBe(
      requiredWorldValue(this.placeholderId, "placeholder id"),
    );
    expect(record.state).toBe("fully_refunded");
    expect(JSON.stringify(record.completion)).toBe(this.firstFailureData);
  },
);
