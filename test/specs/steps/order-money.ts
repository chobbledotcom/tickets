// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { revenueAccount } from "#accounting/accounts.ts";
import { accountBalance } from "#accounting/queries.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  orderCatalog,
  orderJourney,
  placedOrder,
} from "#test/specs/support/orders.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import {
  expectStoredOrder,
  openEditorFromRoster,
} from "#test-utils/order-journey.ts";

// jscpd:ignore-end

const BUYER = "Journey Buyer";

Given(
  "a Deluxe Kit holding a {word} Cabin and a {word} Lodge, and Hampers at {word}",
  function (
    this: TicketsWorld,
    cabin: string,
    lodge: string,
    hamper: string,
  ): void {
    orderCatalog(this, {
      listings: [{ name: "Hamper", price: minorUnits(hamper) }],
      packages: [
        {
          members: [
            { name: "Cabin", price: minorUnits(cabin) },
            { name: "Lodge", price: minorUnits(lodge) },
          ],
          name: "Deluxe Kit",
        },
      ],
      parents: [],
    });
  },
);

When(
  "a customer pays for one kit, another Cabin, and {int} Hampers in one order",
  async function (this: TicketsWorld, hampers: number): Promise<void> {
    await orderJourney(this, {
      form: (c) => ({
        [`package_quantity_${c.group("Deluxe Kit").id}`]: "1",
        [`quantity_${c.listing("Cabin").id}`]: "1",
        [`quantity_${c.listing("Hamper").id}`]: String(hampers),
      }),
      paid: true,
      rows: (c) => [
        [c.listing("Cabin").id, c.group("Deluxe Kit").id, 0, 1, ""],
        [c.listing("Cabin").id, 0, 0, 1, ""],
        [c.listing("Lodge").id, c.group("Deluxe Kit").id, 0, 1, ""],
        [c.listing("Hamper").id, 0, 0, hampers, ""],
      ],
      select: { listings: ["Cabin", "Hamper"], packages: ["Deluxe Kit"] },
    });
  },
);

/** What one listing has earned across every way it was sold. */
const earnedBy = (world: TicketsWorld, name: string): Promise<number> =>
  accountBalance(revenueAccount(placedOrder(world).catalog.listing(name).id));

Then(
  "the Cabin has earned {word} — once in the kit and once on its own",
  async function (this: TicketsWorld, total: string): Promise<void> {
    expect(await earnedBy(this, "Cabin")).toBe(minorUnits(total));
  },
);

Then(
  "the Hampers have earned {word}",
  async function (this: TicketsWorld, total: string): Promise<void> {
    expect(await earnedBy(this, "Hamper")).toBe(minorUnits(total));
  },
);

Then(
  "the organiser sees the Cabin booked both ways",
  async function (this: TicketsWorld): Promise<void> {
    const { browser, catalog } = placedOrder(this);
    const cabin = catalog.listing("Cabin").id;
    await openEditorFromRoster(browser, cabin, BUYER);
    const editor = browser.currentHtml;
    expect(editor).toContain("via Deluxe Kit");
    expect(
      attendeeLineIndex(editor, cabin, catalog.group("Deluxe Kit").id),
    ).not.toBeNull();
    expect(attendeeLineIndex(editor, cabin, 0)).not.toBeNull();
  },
);

Given(
  "a customer ordered a Duo Kit and a Drum on its own",
  async function (this: TicketsWorld): Promise<void> {
    orderCatalog(this, {
      listings: [],
      packages: [{ members: [{ name: "Drum", price: 0 }], name: "Duo Kit" }],
      parents: [],
    });
    await orderJourney(this, {
      form: (c) => ({
        [`package_quantity_${c.group("Duo Kit").id}`]: "1",
        [`quantity_${c.listing("Drum").id}`]: "2",
      }),
      // Both ways it was ordered, before the organiser takes one away.
      rows: (c) => [
        [c.listing("Drum").id, c.group("Duo Kit").id, 0, 1, ""],
        [c.listing("Drum").id, 0, 0, 2, ""],
      ],
      select: { listings: ["Drum"], packages: ["Duo Kit"] },
    });
  },
);

When(
  "the organiser sets the on-its-own Drum to no places",
  async function (this: TicketsWorld): Promise<void> {
    const { browser, catalog } = placedOrder(this);
    const drum = catalog.listing("Drum").id;
    await openEditorFromRoster(browser, drum, BUYER);
    const onItsOwn = attendeeLineIndex(browser.currentHtml, drum, 0);
    expect(onItsOwn).not.toBeNull();
    await browser.submitForm({ [`qty_${onItsOwn}`]: "0" }, "Save Attendee");
    expect(browser.containsText(`Updated ${BUYER}`)).toBe(true);
  },
);

Then(
  "only the Drum inside the Duo Kit is left",
  async function (this: TicketsWorld): Promise<void> {
    const { attendeeId, catalog } = placedOrder(this);
    await expectStoredOrder(attendeeId, [
      [catalog.listing("Drum").id, catalog.group("Duo Kit").id, 0, 1, ""],
    ]);
  },
);
