/** The ticket view shows the modifiers that changed a booking's price. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifiersTable } from "#db/modifiers.ts";
import { handleRequest } from "#routes";
import {
  formatCurrency,
  formatSignedCurrency,
  toMinorUnits,
} from "#shared/currency.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { decryptFirstAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleModifierMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";
import type { Attendee } from "#types";

/** A paid checkout of one £10 ticket that applies one fixed modifier. The
 *  modifier's value is in major units, the way the admin form takes it.
 *  Returns the booking's attendee and the modifier that changed its price. */
const paidBookingWithModifier = async (opts: {
  calcValue: number;
  direction: "charge" | "discount";
  eventId: string;
  name: string;
}): Promise<{ attendee: Attendee; modifierId: number }> => {
  const unitPrice = 1000;
  const amountApplied = toMinorUnits(opts.calcValue);
  await setupStripe();
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice,
  });
  const modifier = await modifiersTable.insert({
    calcKind: "fixed",
    calcValue: opts.calcValue,
    direction: opts.direction,
    name: opts.name,
    trigger: "automatic",
  });
  const amountTotal =
    opts.direction === "charge"
      ? unitPrice + amountApplied
      : unitPrice - amountApplied;
  await expectWebhookProcessed(
    checkoutSessionEvent({
      amountTotal,
      eventId: opts.eventId,
      metadata: singleModifierMeta({
        amountTotal,
        listingId: listing.id,
        modifierId: modifier.id,
        unitPrice,
      }),
      paymentIntent: `pi_${opts.eventId}`,
      sessionId: `cs_${opts.eventId}`,
    }),
  );
  return {
    attendee: await decryptFirstAttendee(listing.id),
    modifierId: modifier.id,
  };
};

/** The ticket view's HTML for one booking. */
const ticketPageHtml = async (attendee: Attendee): Promise<string> => {
  const response = await handleRequest(
    mockRequest(`/t/${attendee.ticket_token}`),
  );
  expect(response.status).toBe(200);
  return await response.text();
};

describeWithEnv("ticket view > modifiers", { db: true }, () => {
  test("shows a surcharge and the total it makes", async () => {
    const { attendee } = await paidBookingWithModifier({
      calcValue: 1,
      direction: "charge",
      eventId: "evt_ticket_charge",
      name: "Service charge",
    });
    const html = await ticketPageHtml(attendee);
    assertStringIncludes(html, `Price: ${formatCurrency(1000)}`);
    assertStringIncludes(
      html,
      `Service charge <span class="ticket-card-modifier-amount">${formatSignedCurrency(100)}</span>`,
    );
    assertStringIncludes(
      html,
      `ticket-card-total"><strong>Total:</strong> ${formatCurrency(1100)}`,
    );
  });

  test("shows a discount with a minus sign and the reduced total", async () => {
    const { attendee } = await paidBookingWithModifier({
      calcValue: 2,
      direction: "discount",
      eventId: "evt_ticket_discount",
      name: "Early bird",
    });
    const html = await ticketPageHtml(attendee);
    assertStringIncludes(
      html,
      `Early bird <span class="ticket-card-modifier-amount">${formatSignedCurrency(-200)}</span>`,
    );
    assertStringIncludes(
      html,
      `ticket-card-total"><strong>Total:</strong> ${formatCurrency(800)}`,
    );
  });

  test("names a deleted modifier with the plain price-change label", async () => {
    const { attendee, modifierId } = await paidBookingWithModifier({
      calcValue: 1,
      direction: "charge",
      eventId: "evt_ticket_deleted",
      name: "Gone offer",
    });
    await modifiersTable.deleteById(modifierId);
    const html = await ticketPageHtml(attendee);
    assertStringIncludes(html, "Price change");
    assertStringIncludes(
      html,
      `ticket-card-modifier-amount">${formatSignedCurrency(100)}</span>`,
    );
  });

  test("puts each card's share of a charge on its own price", async () => {
    await setupStripe();
    const costly = await createTestListing({
      maxAttendees: 50,
      unitPrice: 10_000,
    });
    const cheap = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Service charge",
      trigger: "automatic",
    });
    // £100 + £10 of tickets, plus the 10% charge on both.
    const amountTotal = 12_100;
    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal,
        eventId: "evt_ticket_two_prices",
        metadata: signedMeta(
          {
            email: "priced@example.com",
            items: JSON.stringify([
              { e: costly.id, p: 10_000, q: 1 },
              { e: cheap.id, p: 1000, q: 1 },
            ]),
            modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
            name: "Two Price Buyer",
          },
          amountTotal,
        ),
        paymentIntent: "pi_evt_ticket_two_prices",
        sessionId: "cs_evt_ticket_two_prices",
      }),
    );
    const html = await ticketPageHtml(await decryptFirstAttendee(costly.id));
    // The charge is a tenth of each card's own price: £10 on the first card
    // and £1 on the second.
    assertStringIncludes(
      html,
      `ticket-card-modifier-amount">${formatSignedCurrency(1000)}</span>`,
    );
    assertStringIncludes(
      html,
      `ticket-card-total"><strong>Total:</strong> ${formatCurrency(11_000)}</div>`,
    );
    assertStringIncludes(
      html,
      `ticket-card-modifier-amount">${formatSignedCurrency(100)}</span>`,
    );
    assertStringIncludes(
      html,
      `ticket-card-total"><strong>Total:</strong> ${formatCurrency(1100)}</div>`,
    );
  });
});
