import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { processBooking } from "#shared/booking.ts";
import type { ContactInfo } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

const contact: ContactInfo = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

describeWithEnv("booking", { db: true, triggers: true }, () => {
  test("starts checkout for a one-unit custom price", async () => {
    await setupStripe();
    const listing = testListingWithCount(
      await createTestListing({ unitPrice: 0 }),
    );

    expect(
      await processBooking(listing, contact, 1, null, "http://localhost", 1),
    ).toMatchObject({ type: "checkout" });
  });

  test("a zero custom price overrides a paid listing", async () => {
    await setupStripe();
    const listing = testListingWithCount(
      await createTestListing({ unitPrice: 1000 }),
    );

    expect(
      await processBooking(listing, contact, 1, null, "http://localhost", 0),
    ).toMatchObject({ attendee: { remaining_balance: 0 }, type: "success" });
  });

  test("records a one-unit balance when payments are disabled", async () => {
    const listing = testListingWithCount(
      await createTestListing({ unitPrice: 1 }),
    );

    const result = await processBooking(
      listing,
      contact,
      1,
      null,
      "http://localhost",
    );
    expect(result).toMatchObject({
      attendee: { remaining_balance: 1 },
      type: "success",
    });
    if (result.type !== "success") throw new Error("Expected a direct booking");
    expect(
      await transfersByAccount(attendeeAccount(result.attendee.id)),
    ).toEqual([
      expect.objectContaining({
        amount: 1,
        kind: "sale",
        source: attendeeAccount(result.attendee.id),
      }),
    ]);
  });
});
