/** The ticket view shows the tax that a tax-added order adds to its total. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { assertJson, expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createBooking,
  decryptFirstAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv("ticket view > tax", { db: true }, () => {
  type TaxedPage = [
    name: string,
    mode: "add_to_total" | "calculate_from_total",
    shown: string[],
    hidden: string[],
  ];
  const pages: TaxedPage[] = [
    [
      "shows the net price, the added tax, and the total the buyer paid",
      "add_to_total",
      [
        `Price: ${formatCurrency(1000)}`,
        `ticket-card-tax">Tax: ${formatCurrency(200)}`,
        `ticket-card-total"><strong>Total:</strong> ${formatCurrency(1200)}`,
      ],
      [],
    ],
    [
      "adds no tax row when the listed price already holds its tax",
      "calculate_from_total",
      ["ticket-card-price"],
      ["ticket-card-tax", "ticket-card-total"],
    ],
  ];
  for (const [name, mode, shown, hidden] of pages) {
    test(name, async () => {
      await settings.update.tax({ mode, rateBasisPoints: 2000 });
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await assertJson(createBooking(listing.id), 201);
      const attendee = await decryptFirstAttendee(listing.id);
      const response = await handleRequest(
        mockRequest(`/t/${attendee.ticket_token}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expectIncludesAll(html, shown);
      for (const absent of hidden) expect(html).not.toContain(absent);
    });
  }
});
