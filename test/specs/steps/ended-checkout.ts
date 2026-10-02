import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

const SESSION_ID = "cs_spec_ended";

/** The cancel page's own marker, so the story reads the page's result and
 * not some wording a copy edit could move. */
const CANCEL_MARKER = 'data-payment-result="cancel"';

/** The customer's session read as the provider reports it. The checkout was
 * priced at 1000 and carries a signed booking for one place on the listing. */
const reportSession = (
  world: TicketsWorld,
  status: "expired" | "open",
): void => {
  const listingId = world.listingId!;
  const retrieve = stubRetrieveCheckoutSession({
    amountTotal: 1000,
    email: "returning@example.com",
    items: singleItem(listingId, 1, 1000),
    name: "Returning Customer",
    paymentIntent: "pi_spec_returning",
    paymentStatus: "unpaid",
    sessionId: SESSION_ID,
    status,
  });
  world.cleanup.add(() => retrieve.restore());
};

Given(
  "a customer's unpaid checkout has ended without a payment",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    this.listingId = (await createTestListing({ unitPrice: 1000 })).id;
    reportSession(this, "expired");
    this.sessionId = SESSION_ID;
  },
);

Given(
  "a customer's checkout is still open and unpaid",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    this.listingId = (await createTestListing({ unitPrice: 1000 })).id;
    reportSession(this, "open");
    this.sessionId = SESSION_ID;
  },
);

When(
  "the customer comes back to the checkout",
  { timeout: 15_000 },
  async function (this: TicketsWorld): Promise<void> {
    const sessionId = this.sessionId!;
    const response = await handleRequest(
      mockRequest(`/payment/success?session_id=${sessionId}`),
    );
    this.returnPageHtml = await response.text();
  },
);

Then(
  "they are told the payment was cancelled",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.returnPageHtml).toContain(CANCEL_MARKER);
    expect(this.returnPageHtml).toContain(t("payment.cancel.heading"));
  },
);

Then(
  "they are offered a way to book again",
  async function (this: TicketsWorld): Promise<void> {
    const listing = await getListingWithCount(this.listingId!);
    if (!listing) throw new Error("the story's listing is missing");
    expect(this.returnPageHtml).toContain(`href="/ticket/${listing.slug}"`);
    expect(this.returnPageHtml).toContain(t("payment.cancel.try_again"));
  },
);

Then(
  "they are asked to check again shortly",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.returnPageHtml).not.toContain(CANCEL_MARKER);
    expect(this.returnPageHtml).toContain(t("payment.pending.check_again"));
  },
);

Then(
  "they are not told the payment was cancelled",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.returnPageHtml).not.toContain(t("payment.cancel.heading"));
  },
);
