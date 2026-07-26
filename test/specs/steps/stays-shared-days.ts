// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  visitorBooks,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import {
  dayFromToday,
  guest,
  openStayListing,
  stayListing,
  staysOn,
} from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Two listings that share one day limit, each with its own stay length. The
 * group's own page is where a customer books both at once. */
const shareADayLimit = async (
  world: TicketsWorld,
  cap: number,
  listings: Array<{ days: number; name: string }>,
): Promise<void> => {
  const group = await createTestGroup({
    maxAttendees: cap,
    name: "Shared Days",
    slug: "shared-days",
  });
  for (const { days, name } of listings) {
    // Each listing has room of its own to spare, so the only limit in play is
    // the one they share.
    await openStayListing(world, name, days, 100, { groupId: group.id });
  }
  world.groupSlug = group.slug;
};

Given(
  "a Saturday and a Weekend listing sharing {int} places a day",
  function (this: TicketsWorld, cap: number): Promise<void> {
    return shareADayLimit(this, cap, [
      { days: 1, name: "Saturday" },
      { days: 2, name: "Weekend" },
    ]);
  },
);

Given(
  "a Short and a Long listing sharing {int} places a day",
  function (this: TicketsWorld, cap: number): Promise<void> {
    return shareADayLimit(this, cap, [
      { days: 2, name: "Short" },
      { days: 4, name: "Long" },
    ]);
  },
);

Given(
  "{int} Saturday places and {int} Weekend places are booked starting in {int} days",
  async function (
    this: TicketsWorld,
    onSaturday: number,
    onWeekend: number,
    startsIn: number,
  ): Promise<void> {
    const day = dayFromToday(this, startsIn);
    await visitorBooks(this, stayListing(this, "Saturday"), {
      ...guest(1),
      day,
      places: onSaturday,
    });
    await visitorBooks(this, stayListing(this, "Weekend"), {
      ...guest(2),
      day,
      places: onWeekend,
    });
  },
);

When(
  "a customer tries to book {int} more Saturday place starting in {int} days",
  async function (
    this: TicketsWorld,
    places: number,
    startsIn: number,
  ): Promise<void> {
    const attempt = await visitorTriesToBook(stayListing(this, "Saturday"), {
      ...guest(3),
      day: dayFromToday(this, startsIn),
      places,
    });
    this.customerBrowser = attempt.browser;
    this.bookingWasTaken = attempt.wasBooked;
  },
);

When(
  "a customer books {int} Weekend places starting in {int} days",
  async function (
    this: TicketsWorld,
    places: number,
    startsIn: number,
  ): Promise<void> {
    await visitorBooks(this, stayListing(this, "Weekend"), {
      ...guest(4),
      day: dayFromToday(this, startsIn),
      places,
    });
  },
);

When(
  "a customer tries to book {int} Short places and {int} Long places in one order",
  async function (
    this: TicketsWorld,
    onShort: number,
    onLong: number,
  ): Promise<void> {
    // One order over the group's own page, which offers a quantity per listing —
    // exactly how a customer books two listings at once.
    const browser = new TestBrowser();
    const slug = requiredWorldValue(this.groupSlug, "the group's page");
    await browser.visit(`/ticket/${slug}`);
    const short = stayListing(this, "Short");
    const long = stayListing(this, "Long");
    expect(browser.currentHtml).toContain(`quantity_${short.id}`);
    expect(browser.currentHtml).toContain(`quantity_${long.id}`);
    await browser.submitForm(
      {
        ...{ email: guest(5).email, name: guest(5).who },
        date: dayFromToday(this, 10),
        [`quantity_${short.id}`]: String(onShort),
        [`quantity_${long.id}`]: String(onLong),
      },
      "Continue",
    );
    this.customerBrowser = browser;
    this.bookingWasTaken = browser.pageText.includes(
      "Thank you for your order",
    );
  },
);

Then(
  "the order is refused and nothing is booked",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.bookingWasTaken).toBe(false);
    // Refused for want of room, not for some unrelated reason.
    expect(this.customerBrowser?.pageText).toContain("enough spots available");
    // Neither half of the order may be taken — a partly-booked order would
    // leave the customer paying for a stay they cannot use.
    expect((await staysOn(this, "Short")).length).toBe(0);
    expect((await staysOn(this, "Long")).length).toBe(0);
  },
);
