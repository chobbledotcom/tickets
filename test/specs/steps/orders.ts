// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  orderCatalog,
  orderJourney,
  placedOrder,
} from "#test/specs/support/orders.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import {
  lineCountFor,
  lineQty,
  openEditorFromRoster,
} from "#test-utils/order-journey.ts";

// jscpd:ignore-end

const BUYER = "Journey Buyer";

Given(
  "the shop sells a Mega Kit bundle, a Marquee with a Generator add-on, T-Shirts, and a Campervan by the day",
  function (this: TicketsWorld): void {
    this.orderDay = addDays(todayInTz(settings.timezone), 3);
    orderCatalog(this, {
      listings: [{ name: "T-Shirt" }, { daily: true, name: "Campervan" }],
      packages: [
        {
          members: [
            { name: "Tent", price: 0, quantity: 2 },
            { name: "Stove", price: 0 },
          ],
          name: "Mega Kit",
        },
      ],
      parents: [{ childName: "Generator", name: "Marquee" }],
    });
  },
);

When(
  "a customer orders all of them at once, adding a Tent and a Generator on their own",
  async function (this: TicketsWorld): Promise<void> {
    const day = this.orderDay!;
    await orderJourney(this, {
      form: (c) => ({
        date: day,
        name: "Complex Buyer",
        [`package_quantity_${c.group("Mega Kit").id}`]: "1",
        [`quantity_${c.listing("Campervan").id}`]: "1",
        [`quantity_${c.listing("Generator").id}`]: "1",
        [`quantity_${c.listing("Marquee").id}`]: "1",
        [`quantity_${c.listing("Tent").id}`]: "1",
        [`quantity_${c.listing("T-Shirt").id}`]: "3",
      }),
      // One booking per way it was ordered: the Tent through the bundle (2 a
      // unit) and on its own, the Generator under the Marquee and on its own,
      // and the Campervan on the day the customer picked.
      rows: (c) => [
        [c.listing("Tent").id, c.group("Mega Kit").id, 0, 2, ""],
        [c.listing("Tent").id, 0, 0, 1, ""],
        [c.listing("Stove").id, c.group("Mega Kit").id, 0, 1, ""],
        [c.listing("Marquee").id, 0, 0, 1, ""],
        [c.listing("Generator").id, 0, c.listing("Marquee").id, 1, ""],
        [c.listing("Generator").id, 0, 0, 1, ""],
        [c.listing("T-Shirt").id, 0, 0, 3, ""],
        [c.listing("Campervan").id, 0, 0, 1, day],
      ],
      select: {
        date: day,
        listings: ["Tent", "Marquee", "Generator", "T-Shirt", "Campervan"],
        packages: ["Mega Kit"],
      },
    });
    this.attendeeName = "Complex Buyer";
  },
);

/** Open the buyer's order as the organiser reads it, from a listing's own list. */
const openOrder = async (
  world: TicketsWorld,
  listingName: string,
): Promise<string> => {
  const { browser, catalog } = placedOrder(world);
  await openEditorFromRoster(
    browser,
    catalog.listing(listingName).id,
    world.attendeeName ?? BUYER,
  );
  return browser.currentHtml;
};

Then(
  "the organiser sees the Tent twice — {int} in the bundle and {int} on its own",
  async function (
    this: TicketsWorld,
    inBundle: number,
    onItsOwn: number,
  ): Promise<void> {
    const editor = await openOrder(this, "Tent");
    const { catalog } = placedOrder(this);
    const tent = catalog.listing("Tent").id;
    const viaKit = attendeeLineIndex(
      editor,
      tent,
      catalog.group("Mega Kit").id,
    );
    const ownRow = attendeeLineIndex(editor, tent, 0);
    expect(viaKit).not.toBeNull();
    expect(ownRow).not.toBeNull();
    // Two separate bookings, not one merged into the other.
    expect(viaKit).not.toBe(ownRow);
    expect(lineQty(editor, viaKit!)).toBe(String(inBundle));
    expect(lineQty(editor, ownRow!)).toBe(String(onItsOwn));
  },
);

Then(
  "the organiser sees the Generator twice — under the Marquee and on its own",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openOrder(this, "Tent");
    const { catalog } = placedOrder(this);
    expect(lineCountFor(editor, catalog.listing("Generator").id)).toBe(2);
  },
);

Then(
  "each booking says which bundle or parent it came from",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openOrder(this, "Tent");
    expect(editor).toContain("via Mega Kit");
    expect(editor).toContain("add-on under Marquee");
    // The day the customer picked rides with the order.
    expect(editor).toContain('name="start_date"');
    expect(editor).toContain(`value="${this.orderDay}"`);
  },
);

Then(
  "every listing in the order lists the customer",
  async function (this: TicketsWorld): Promise<void> {
    const { browser, catalog } = placedOrder(this);
    for (const name of [
      "Tent",
      "Stove",
      "Marquee",
      "Generator",
      "T-Shirt",
      "Campervan",
    ]) {
      await browser.visit(
        `/admin/listing/${catalog.listing(name).id}/attendees`,
      );
      expect(browser.containsText("Complex Buyer")).toBe(true);
    }
  },
);

Given(
  "the shop sells a Camp Kit and a Glamp Kit that both include a Tent",
  function (this: TicketsWorld): void {
    orderCatalog(this, {
      listings: [],
      packages: [
        { members: [{ name: "Tent", price: 0 }], name: "Camp Kit" },
        {
          members: [
            { name: "Tent", price: 0 },
            { name: "Rug", price: 0 },
          ],
          name: "Glamp Kit",
        },
      ],
      parents: [],
    });
  },
);

When(
  "a customer orders one of each bundle",
  async function (this: TicketsWorld): Promise<void> {
    await orderJourney(this, {
      form: (c) => ({
        [`package_quantity_${c.group("Camp Kit").id}`]: "1",
        [`package_quantity_${c.group("Glamp Kit").id}`]: "1",
      }),
      rows: (c) => [
        [c.listing("Tent").id, c.group("Camp Kit").id, 0, 1, ""],
        [c.listing("Tent").id, c.group("Glamp Kit").id, 0, 1, ""],
        [c.listing("Rug").id, c.group("Glamp Kit").id, 0, 1, ""],
      ],
      select: { listings: [], packages: ["Camp Kit", "Glamp Kit"] },
    });
  },
);

Then(
  "the organiser sees a Tent booking for each bundle",
  async function (this: TicketsWorld): Promise<void> {
    const editor = await openOrder(this, "Tent");
    const { catalog } = placedOrder(this);
    const tent = catalog.listing("Tent").id;
    for (const bundle of ["Camp Kit", "Glamp Kit"]) {
      expect(editor).toContain(`via ${bundle}`);
      expect(
        attendeeLineIndex(editor, tent, catalog.group(bundle).id),
      ).not.toBeNull();
    }
  },
);
