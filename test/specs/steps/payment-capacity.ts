// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { getNoteRows } from "#shared/db/system-notes.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { fillSoleCapacityListing } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
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
  getKeptPlaceholders,
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
    await expectAttendeeCreatedWithPiiBlob(listingId);
    const record = await isSessionProcessed(sessionId);
    expect(record?.attendee_id).not.toBeNull();
    expect(record?.ticket_tokens).not.toBe("");
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
    expect((await getNoteRows([attendeeId])).length).toBe(1);
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
    const record = await isSessionProcessed(sessionId);
    if (!record?.failure_data)
      throw new Error("terminal failure was not stored");
    this.firstFailureData = record.failure_data;
    await expectRefundedWithNote(attendee.id, refund);
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
    expect((await getKeptPlaceholders(listingId)).map(({ id }) => id)).toEqual([
      requiredWorldValue(this.placeholderId, "placeholder id"),
    ]);
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
    expect(this.firstBody).toContain("saved your details");
    expect(this.secondBody).toContain("saved your details");
    expect(this.secondBody).not.toContain("being processed");
    const sessionId = requiredWorldValue(this.sessionId, "session id");
    expect((await isSessionProcessed(sessionId))?.failure_data).toBe(
      this.firstFailureData,
    );
  },
);
