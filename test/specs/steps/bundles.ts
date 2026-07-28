// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { toMinorUnits } from "#shared/currency.ts";
import {
  bundleChargeForOrNull,
  bundleStillExists,
  buyersTicket,
  customerBuysBundle,
  expectPartOnSaleAlone,
  GROUP_SAVED,
  isStillABundle,
  organiserDeletesBundle,
  organiserRevealsParts,
  organiserSellsAsBundle,
  organiserStopsBundling,
  type PartOfBundle,
  type ThingForSale,
  thingsGroupedTogether,
} from "#test/specs/support/bundles.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "a {word} group holding a {word} at {float} and a {word} at {float}",
  function (
    this: TicketsWorld,
    bundle: string,
    firstPart: string,
    firstPrice: number,
    secondPart: string,
    secondPrice: number,
  ): Promise<void> {
    this.bundleParts = [
      { name: firstPart, ownPrice: firstPrice },
      { name: secondPart, ownPrice: secondPrice },
    ];
    return thingsGroupedTogether(this, bundle, partsOf(this));
  },
);

const partsOf = (world: TicketsWorld): ThingForSale[] => {
  const parts = world.bundleParts;
  if (!parts) throw new Error("The story grouped nothing together");
  return parts;
};

/** The organiser turns the group into a bundle, however the story words it. */
const sellAsBundle = async function (
  this: TicketsWorld,
  bundle: string,
  priced: PartOfBundle[],
  keepPartsPrivate: boolean,
): Promise<void> {
  await organiserSellsAsBundle(this, bundle, priced, keepPartsPrivate);
};

When(
  "the organiser sells the {word} as a bundle, with the {word} at {float} and the {word} left blank",
  function (
    this: TicketsWorld,
    bundle: string,
    priced: string,
    price: number,
    blank: string,
  ): Promise<void> {
    return sellAsBundle.call(
      this,
      bundle,
      [{ bundlePrice: price, name: priced }, { name: blank }],
      false,
    );
  },
);

Given(
  "the organiser sells the {word} as a private bundle",
  function (this: TicketsWorld, bundle: string): Promise<void> {
    return sellAsBundle.call(this, bundle, partsOf(this), true);
  },
);

Given(
  "a customer buys the {word}",
  function (this: TicketsWorld, bundle: string): Promise<void> {
    return customerBuysBundle(this, bundle);
  },
);

When(
  "the organiser stops selling the {word} as a bundle",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    this.bundleRefusal = await organiserStopsBundling(this, bundle);
  },
);

When(
  "the organiser lets people see what is inside the {word}",
  function (this: TicketsWorld, bundle: string): Promise<void> {
    return organiserRevealsParts(this, bundle);
  },
);

When(
  "the organiser tries to delete the {word}",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    this.bundleRefusal = await organiserDeletesBundle(this, bundle);
  },
);

Then(
  "the organiser is told to make its contents public first",
  function (this: TicketsWorld): void {
    // The site's own words, so a refusal that stopped explaining itself — or
    // stopped happening at all — fails here rather than passing quietly.
    expect(
      requiredWorldValue(this.bundleRefusal, "what the organiser was told"),
    ).toContain(t("error.sold_hidden_package"));
  },
);

/** The site sells this as one bundle, however the story words the check. */
const expectSoldAsBundle = async function (
  this: TicketsWorld,
  bundle: string,
): Promise<void> {
  expect(await isStillABundle(this, bundle)).toBe(true);
};

Then("the {word} is sold as one bundle", expectSoldAsBundle);
Then("the {word} is still sold as one bundle", expectSoldAsBundle);

Then(
  "the {word} is no longer sold as one bundle",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    expect(await isStillABundle(this, bundle)).toBe(false);
  },
);

Then(
  "the bundle charges {float} for the {word}",
  async function (
    this: TicketsWorld,
    price: number,
    part: string,
  ): Promise<void> {
    expect(await bundleChargeForOrNull(this, onlyBundle(this), part)).toBe(
      toMinorUnits(price),
    );
  },
);

Then(
  "the bundle sets no price of its own for the {word}",
  async function (this: TicketsWorld, part: string): Promise<void> {
    // The part is still in the bundle — reading its price is what says so.
    expect(
      await bundleChargeForOrNull(this, onlyBundle(this), part),
    ).toBeNull();
  },
);

const onlyBundle = (world: TicketsWorld): string => {
  const [name, ...rest] = requiredWorldValue(
    world.bundles,
    "the story's bundles",
  ).keys();
  if (!name || rest.length > 0)
    throw new Error("The story has no single bundle");
  return name;
};

/** What the buyer's ticket does or does not say, from one reading of it. */
const expectTicketNaming = (shown: boolean) =>
  async function (this: TicketsWorld, thing: string): Promise<void> {
    const ticket = await buyersTicket(this);
    if (shown) expect(ticket).toContain(thing);
    else expect(ticket).not.toContain(thing);
  };

Then("their ticket names the {word}", expectTicketNaming(true));
Then("their ticket never names the {word}", expectTicketNaming(false));

Then(
  "the {word} is still there",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    expect(await bundleStillExists(this, bundle)).toBe(true);
  },
);

Then(
  "the {word} is gone",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    expect(await bundleStillExists(this, bundle)).toBe(false);
  },
);

Then(
  "the {word} is still for sale on its own",
  function (this: TicketsWorld, part: string): Promise<void> {
    return expectPartOnSaleAlone(this, part);
  },
);

/** What the page they bought from did or did not say. */
const expectBookingPageNaming = (shown: boolean) =>
  function (this: TicketsWorld, thing: string): void {
    const page = requiredWorldValue(this.bundleBookingPage, "the booking page");
    if (shown) expect(page).toContain(thing);
    else expect(page).not.toContain(thing);
  };

Then("the booking page named the {word}", expectBookingPageNaming(true));
Then("the booking page never named the {word}", expectBookingPageNaming(false));

Then("the organiser is told it saved", function (this: TicketsWorld): void {
  // A save that quietly failed would leave the same bundle behind as one the
  // site refused, so the story reads what the organiser was actually told.
  expect(
    requiredWorldValue(this.bundleRefusal, "what the organiser was told"),
  ).toContain(GROUP_SAVED);
});
