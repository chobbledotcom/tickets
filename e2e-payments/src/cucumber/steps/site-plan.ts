import { Then, When } from "@cucumber/cucumber";
import { catalogWords } from "#e2e/catalog-words.ts";
import { config } from "#e2e/config.ts";
import { payStripeWithHeldReturn } from "#e2e/cucumber/steps/booking.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
import { submitBooking, waitForHostedCheckout } from "#e2e/flow.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";

/** The detail the app writes on the log's lost-assignment entry, shared with
 * the reporting line in src/shared/webhook/delivery.ts. */
const LOST_ASSIGNMENT_DETAIL =
  "Site assignment failed after a completed booking";

When(
  "a separate visitor pays for three units through Stripe Checkout",
  { timeout: config.hostedPaymentStepTimeoutMs },
  async function (this: LiveWorld): Promise<void> {
    // The plan's months pricing is asserted while the visitor still has the
    // page: the checkout selector names months, and each count states what
    // it buys — three units of this three-month plan read "9 months". The
    // words come from the catalog, so a rename travels with the app.
    const buyer = this.resources.visitor;
    await buyer.goto(this.bookingPath);
    const body = await buyer.bodyText();
    const numberOfMonths = await catalogWords(
      "tickets",
      "public.ticket.number_of_months",
    );
    const threeUnitsBuy = await catalogWords(
      "tickets",
      "public.ticket.month_option",
      {
        count: 9,
      },
    );
    if (!body.includes(numberOfMonths) || !body.includes(threeUnitsBuy)) {
      await buyer.dumpPage("plan-page-not-priced-in-months");
      throw new Error(
        `the plan's booking page must price it in months (expected ` +
          `"${numberOfMonths}" and "${threeUnitsBuy}"); got:\n${body.slice(0, 600)}`,
      );
    }
    this.recordPhase("plan-prices-in-months");
    await submitBooking(buyer, this.bookingPath, this.scenario.booker, "3");
    await waitForHostedCheckout(buyer);
    await payStripeWithHeldReturn(this);
  },
);

Then(
  "the owner's log records the lost site assignment",
  async function (this: LiveWorld): Promise<void> {
    // The sandbox has no build infrastructure, so the plan's post-payment
    // build dies. The booking and its money stand; the lost site, its month,
    // and its setup email are the outcome that must not vanish silently, so
    // the owner's log must carry the incident that names it.
    const owner = this.resources.owner;
    await owner.goto("/admin/log");
    const body = await owner.bodyText();
    const expected = `${errorCodeLabel[ErrorCode.SITE_ASSIGNMENT]} (${LOST_ASSIGNMENT_DETAIL})`;
    if (!body.includes(expected)) {
      await owner.dumpPage("lost-assignment-missing-from-log");
      throw new Error(
        `the owner's log must record the plan's lost site assignment as ` +
          `"${expected}" — the buyer paid and the booking stands, so without ` +
          "this entry nothing tells the operator to repair the site by hand. " +
          "If the log shows a CDN request failure for the auto-built site " +
          "instead, the release download failed before the build began and " +
          `the failure took the pre-recorded path. Got:\n${body.slice(0, 600)}`,
      );
    }
  },
);
