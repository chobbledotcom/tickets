/**
 * The Given steps: provider configuration, listing publication, and the
 * visitor's journey start. Setup, sign-in, provider configuration and listing
 * creation live in these visible steps — never in hooks.
 */

import { Given, Then, When } from "@cucumber/cucumber";
import { config } from "#e2e/config.ts";
// jscpd:ignore-start -- the #e2e alias import for LiveWorld is structural
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
// jscpd:ignore-end
import {
  assertFreeThankYou,
  createListing,
  waitForHostedCheckout,
} from "#e2e/flow.ts";
import { buildOrderCatalog, type OrderCatalog } from "#e2e/order-flow.ts";
import type { ProviderName } from "#e2e/providers/types.ts";
import {
  bookAsVisitor,
  requireNoPaymentIncome,
  requireSingleBooking,
} from "./pages.ts";

const requireProvider = (world: LiveWorld, name: ProviderName): void => {
  if (world.target !== name) {
    throw new Error(
      `this scenario needs ${name}, but the harness is running the ${world.target} target`,
    );
  }
};

/** Set the target's provider up through the admin settings page. */
const configureCurrentProvider = async (world: LiveWorld): Promise<void> => {
  await world.prepareOwner();
  const { provider, secrets } = world.paidProvider;
  await provider.configure(world.resources.owner, secrets);
  world.recordPhase("provider-configured");
};

/** Publish the scenario's single listing at the given price. */
const publishPricedListing = async (
  world: LiveWorld,
  priceMinor: number,
): Promise<void> => {
  await world.prepareOwner();
  const path = await createListing(world.resources.owner, {
    name: world.scenario.listingName,
    priceMinor,
  });
  world.rememberListing(path);
  world.recordPhase("listing-published");
};

Given(
  /^(Stripe|Square|SumUp) is configured with dedicated (?:test|sandbox) credentials$/,
  async function (this: LiveWorld, name: string): Promise<void> {
    requireProvider(this, name.toLowerCase() as ProviderName);
    await configureCurrentProvider(this);
  },
);

/** The listing-publication Givens: each step text and the price it sets. */
const PUBLISHED_LISTING_STEPS: readonly [string, number][] = [
  ["the owner has published a free listing", 0],
  ["the owner has published a priced listing", config.unitPrice],
];

for (const [text, priceMinor] of PUBLISHED_LISTING_STEPS) {
  Given(text, async function (this: LiveWorld) {
    await publishPricedListing(this, priceMinor);
  });
}

Given(
  "a separate visitor has begun paying for a priced listing",
  async function (this: LiveWorld): Promise<void> {
    requireProvider(this, "stripe");
    await configureCurrentProvider(this);
    await publishPricedListing(this, config.unitPrice);
    // The visitor submits the booking and is now parked on Stripe Checkout,
    // mid-payment — the price change happens while this checkout is open.
    await bookAsVisitor(this);
    await waitForHostedCheckout(this.resources.visitor);
    this.recordPhase("visitor-mid-checkout");
  },
);

Given(
  "the owner has published a package, its members and a plain listing",
  async function (this: LiveWorld): Promise<void> {
    await this.prepareOwner();
    // A paid catalog needs the provider configured before anything is booked,
    // or the whole order prices as a provider-less free reservation.
    const paid = this.target !== "free";
    if (paid) await configureCurrentProvider(this);
    const { runId } = this.scenario;
    const catalog: OrderCatalog = {
      kit: `E2E Kit ${runId}`,
      memberA: `E2E Tent ${runId}`,
      memberB: `E2E Stove ${runId}`,
      plain: `E2E Hamper ${runId}`,
    };
    const built = await buildOrderCatalog(
      this.resources.owner,
      {
        booker: this.scenario.booker,
        catalog,
        owner: this.scenario.owner,
      },
      { paid },
    );
    this.rememberBuiltOrder(built, catalog);
    this.recordPhase("order-catalog-published");
  },
);

When(
  "a separate visitor books the listing",
  async function (this: LiveWorld): Promise<void> {
    await bookAsVisitor(this);
  },
);

Then(
  "the visitor sees the booking confirmation",
  async function (this: LiveWorld): Promise<void> {
    await assertFreeThankYou(this.resources.visitor);
  },
);

Then(
  "the owner sees one attendee and no payment income",
  async function (this: LiveWorld): Promise<void> {
    await requireSingleBooking(
      this,
      `booking for ${this.scenario.booker.email}`,
    );
    // A free booking recognises no money.
    await requireNoPaymentIncome(this);
  },
);
