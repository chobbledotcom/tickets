import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { copyLoaded } from "#test/specs/support/copy.ts";
import { soleBookingOn } from "#test/specs/support/public-booking.ts";
import {
  expectNothingBookedYet,
  payThroughSumupWithoutTheSiteHearing,
  sumupHoldsTheMoney,
} from "#test/specs/support/sumup-recovery.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

/** The lost payment this story is about, failing loudly when no step has
 * bought it yet. */
const lostPayment = (world: TicketsWorld) =>
  requiredWorldValue(world.sumupLostPayment, "the lost payment");

Given(
  "{word} pays for a {float} {word} place through SumUp on the public booking page",
  async function (
    this: TicketsWorld,
    who: string,
    pounds: number,
    listing: string,
  ): Promise<void> {
    this.sumupLostPayment = await payThroughSumupWithoutTheSiteHearing(this, {
      listingName: listing,
      pounds: pounds.toFixed(2),
      who,
    });
  },
);

Given("the customer did pay SumUp", function (this: TicketsWorld): void {
  sumupHoldsTheMoney(this, lostPayment(this));
});

Given(
  "the site never hears that the payment arrived",
  async function (this: TicketsWorld): Promise<void> {
    await expectNothingBookedYet(lostPayment(this).listingId);
  },
);

Then(
  "the payment is booked",
  async function (this: TicketsWorld): Promise<void> {
    // Exactly one booking, whatever booked it: with the callback lost and the
    // buyer gone, recovery is the only thing left that could have.
    this.attendeeId = await soleBookingOn(lostPayment(this).listingId);
  },
);

When(
  "the customer opens the payment link they were given",
  async function (this: TicketsWorld): Promise<void> {
    await copyLoaded("payment");
    this.paymentLinkSaid = (
      await openAsNewcomer(
        `/payment/success?session_id=${lostPayment(this).reference}`,
      )
    ).pageText;
  },
);

Then(
  "they reach the page that says their payment was successful",
  function (this: TicketsWorld): void {
    // The site's own success words, so a reworded page fails the story.
    const said = requiredWorldValue(
      this.paymentLinkSaid,
      "the payment link's page",
    );
    expect(said).toContain(t("payment.success.title"));
    expect(said).toContain(t("payment.success.heading"));
  },
);

Then(
  "the payment is still booked exactly once",
  async function (this: TicketsWorld): Promise<void> {
    // The recovered checkout, opened again, must not book a second time.
    await soleBookingOn(lostPayment(this).listingId);
  },
);
