/** The ticket view shows the tax that a tax-added order adds to its total. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { processBooking } from "#shared/booking.ts";
import { formatCurrency } from "#shared/currency.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { withSetting } from "#test-utils/settings.ts";

const contact = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

/** The ticket view's HTML for a two-ticket booking of a £10 listing made while
 *  the site holds this tax policy. */
const ticketPageUnderTax = async (policy: {
  mode: string;
  rateBasisPoints: number;
}): Promise<string> =>
  withSetting({ tax: JSON.stringify(policy) }, async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 1000,
    });
    const result = await processBooking(
      listing,
      contact,
      2,
      null,
      "http://localhost",
    );
    if (result.type !== "success") throw new Error("Booking did not complete");
    const response = await handleRequest(
      mockRequest(`/t/${result.attendee.ticket_token}`),
    );
    expect(response.status).toBe(200);
    return await response.text();
  });

describeWithEnv("ticket view > tax", { db: true, triggers: true }, () => {
  test("shows the net price, the added tax, and the total the buyer paid", async () => {
    const html = await ticketPageUnderTax({
      mode: "add_to_total",
      rateBasisPoints: 2000,
    });
    expectIncludesAll(html, [
      `Price: ${formatCurrency(2000)}`,
      `ticket-card-tax">Tax: ${formatCurrency(400)}`,
      `ticket-card-total"><strong>Total:</strong> ${formatCurrency(2400)}`,
    ]);
  });

  test("adds no tax row when the listed price already holds its tax", async () => {
    const html = await ticketPageUnderTax({
      mode: "calculate_from_total",
      rateBasisPoints: 2000,
    });
    expect(html).toContain("ticket-card-price");
    expect(html).not.toContain("ticket-card-tax");
    expect(html).not.toContain("ticket-card-total");
  });
});
