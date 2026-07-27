// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  bundlePrices,
  bundleStillExists,
  buyersTicket,
  customerBuysBundle,
  isStillABundle,
  organiserDeletesBundle,
  organiserRevealsParts,
  organiserSellsAsBundle,
  organiserStopsBundling,
  type PartOfBundle,
  partStillExists,
} from "#test/specs/support/bundles.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Money as the story writes it, in the smallest units the site stores. */
const inPennies = (amount: number): number => Math.round(amount * 100);

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
    return thingsGrouped(this, bundle);
  },
);

/** The things the story grouped together, as the organiser will price them. */
const partsOf = (world: TicketsWorld): PartOfBundle[] => {
  const parts = world.bundleParts;
  if (!parts) throw new Error("The story grouped nothing together");
  return parts;
};

const thingsGrouped = async (
  world: TicketsWorld,
  bundle: string,
): Promise<void> => {
  const { thingsGroupedTogether } = await import(
    "#test/specs/support/bundles.ts"
  );
  await thingsGroupedTogether(world, bundle, partsOf(world));
};

/** The organiser turns the group into a bundle, however the story words it. */
const sellAsBundle = async function (
  this: TicketsWorld,
  bundle: string,
  priced: PartOfBundle[],
  keepPartsPrivate: boolean,
): Promise<void> {
  await organiserSellsAsBundle(this, bundle, priced, { keepPartsPrivate });
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
  function (this: TicketsWorld, bundle: string): Promise<void> {
    return organiserStopsBundling(this, bundle);
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
    await organiserDeletesBundle(this, bundle);
  },
);

Then(
  "the {word} is sold as one bundle",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    expect(await isStillABundle(this, bundle)).toBe(true);
  },
);

Then(
  "the {word} is still sold as one bundle",
  async function (this: TicketsWorld, bundle: string): Promise<void> {
    expect(await isStillABundle(this, bundle)).toBe(true);
  },
);

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
    const charged = await bundlePrices(this, onlyBundle(this));
    expect(charged.get(part)).toBe(inPennies(price));
  },
);

Then(
  "the bundle sets no price of its own for the {word}",
  async function (this: TicketsWorld, part: string): Promise<void> {
    const charged = await bundlePrices(this, onlyBundle(this));
    expect([...charged.keys()]).not.toContain(part);
  },
);

/** The one bundle these stories talk about. */
const onlyBundle = (world: TicketsWorld): string => {
  const names = [...(world.bundles?.keys() ?? [])];
  if (names.length !== 1) throw new Error("The story has no single bundle");
  return names[0] as string;
};

Then(
  "their ticket names the {word}",
  async function (this: TicketsWorld, thing: string): Promise<void> {
    expect(await buyersTicket(this)).toContain(thing);
  },
);

Then(
  "their ticket never names the {word}",
  async function (this: TicketsWorld, thing: string): Promise<void> {
    expect(await buyersTicket(this)).not.toContain(thing);
  },
);

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
  async function (this: TicketsWorld, part: string): Promise<void> {
    expect(await partStillExists(this, part)).toBe(true);
  },
);
