/**
 * Direct tests for the contact fields at form parse: a paid order without its
 * email gets the error redirect, and a valid form keeps the values the form
 * carries.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { validateTicketFields } from "#routes/public/ticket-submit/parse.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { quantityForm, ticketContext } from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("validateTicketFields", () => {
    test("answers a paid order missing its email with the error redirect", async () => {
      const listing = await createTestListing({ fields: "email" });
      const ctx = await ticketContext([listing.id]);

      const result = validateTicketFields(
        quantityForm({ [listing.id]: 1 }),
        ctx,
        true,
      );
      expect(result).toBeInstanceOf(Response);
    });

    test("keeps the contact values the form carries", async () => {
      const listing = await createTestListing({ fields: "email" });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set("email", "buyer@example.com");
      form.set("name", "Buyer");

      const result = validateTicketFields(form, ctx, true);
      expect(result).not.toBeInstanceOf(Response);
      if (result instanceof Response) return;
      expect(result.email).toBe("buyer@example.com");
      expect(result.name).toBe("Buyer");
    });
  });
});
