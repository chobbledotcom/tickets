import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import { processBooking } from "#shared/booking.ts";
import { expectFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMonthlyPlan } from "#test-utils/db-helpers/subscriptions.ts";
import { expectNoBooking, makeParent } from "#test-utils/parents.ts";
import {
  setPublicReservation,
  submitBuyerOrder,
} from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";

const CONTACT = {
  address: "",
  email: "member@example.com",
  name: "Member",
  phone: "",
  special_instructions: "",
};

const NEEDS_STRIPE = "payment.error.subscription_needs_stripe";

const monthlyListing = async () =>
  withMonthlyPlan(
    await createTestListing({ maxAttendees: 10, unitPrice: 1000 }),
  );

/** Submit one ticket of `listing` on the public page and expect the refusal
 * `message`, with no booking made. */
const expectRefusedOrder = async (
  listing: { id: number; slug: string },
  message: string,
): Promise<void> => {
  const response = await submitBuyerOrder(listing);
  expect(response.status).toBe(302);
  expectFlash(response, t(message), false);
  await expectNoBooking(listing);
};

describeWithEnv("subscription orders", { db: true, triggers: true }, () => {
  test("refuses a subscription that a free reservation would book", async () => {
    await setupStripe();
    await settings.update.bookingFee("0");
    await setPublicReservation("0");
    await expectRefusedOrder(
      await monthlyListing(),
      "payment.error.subscription_no_deposit",
    );
  });

  test("refuses a subscription on a site that takes no payment", async () => {
    await expectRefusedOrder(await monthlyListing(), NEEDS_STRIPE);
  });

  test("refuses a subscription through the API on a site that takes no payment", async () => {
    const listing = await monthlyListing();
    expect(
      await processBooking(listing, CONTACT, 1, null, "http://localhost"),
    ).toEqual({ error: t(NEEDS_STRIPE), type: "checkout_failed" });
    await expectNoBooking(listing);
  });

  test("refuses a subscription parent through the API on a site that takes no payment", async () => {
    const { child, parent } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 0 }],
      parent: { maxAttendees: 10, unitPrice: 1000 },
    });
    const response = await processParentApiBooking(
      new Request("http://localhost/api/listings/x/book", {
        headers: { host: "localhost" },
        method: "POST",
      }),
      await withMonthlyPlan(parent),
      {
        children: [{ quantity: 1, slug: child.slug }],
        email: CONTACT.email,
        name: CONTACT.name,
        quantity: 1,
      },
      1,
      null,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: t(NEEDS_STRIPE) });
    await expectNoBooking(parent);
  });
});
