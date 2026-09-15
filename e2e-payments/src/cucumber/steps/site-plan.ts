import { When } from "@cucumber/cucumber";
import { catalogWords } from "#e2e/catalog-words.ts";
import { config } from "#e2e/config.ts";
import { payStripeWithHeldReturn } from "#e2e/cucumber/steps/booking.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
import { submitBooking, waitForHostedCheckout } from "#e2e/flow.ts";

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
