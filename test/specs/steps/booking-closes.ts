/**
 * Booking at and after the moment a listing closes: what the page says, what
 * an order with one closed part does, and what becomes of an order sent in
 * the last second.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { quantityFieldName } from "#booking/tree.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { t } from "#i18n";
import { REGISTRATION_CLOSED_SUBMIT_MESSAGE } from "#routes/public/types.ts";
import { closesOn } from "#test/specs/support/booking-closes.ts";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls/rules.ts";
import {
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  openBookingPage,
  visitorFillsInBooking,
} from "#test/specs/support/public-booking.ts";
import {
  fillsIn,
  sentOrder,
  THE_CUSTOMER,
} from "#test/specs/support/refused-orders.ts";
import { combinedPath } from "#test/specs/support/sales-pages.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "a Trip that stopped taking bookings yesterday",
  async function (this: TicketsWorld): Promise<void> {
    await putsPlainThingOnSale(this, "Trip");
    await closesOn(this, "Trip", -1);
  },
);

Given(
  "a Trip that stops taking bookings tomorrow",
  async function (this: TicketsWorld): Promise<void> {
    await putsPlainThingOnSale(this, "Trip");
    await closesOn(this, "Trip", 1);
  },
);

Given(
  "a Trip and a Mug that stopped taking bookings yesterday",
  async function (this: TicketsWorld): Promise<void> {
    await putsPlainThingOnSale(this, "Trip");
    await putsPlainThingOnSale(this, "Mug");
    await closesOn(this, "Trip", -1);
    await closesOn(this, "Mug", -1);
  },
);

Given(
  "a customer filled the Trip page in, asking for {int} place(s)",
  async function (this: TicketsWorld, places: number): Promise<void> {
    const listing = listingNamed(this, "Trip");
    await fillsIn(this, `/ticket/${listing.slug}`, [{ listing, places }], {
      ...THE_CUSTOMER,
    });
  },
);

Given(
  "a customer filled the page selling the Trip and the Mug in, asking for one of each",
  async function (this: TicketsWorld): Promise<void> {
    const lines = [listingNamed(this, "Trip"), listingNamed(this, "Mug")].map(
      (listing) => ({ listing, places: 1 }),
    );
    await fillsIn(this, combinedPath(lines), lines, { ...THE_CUSTOMER });
  },
);

When(
  "the organiser closes the Trip to bookings",
  async function (this: TicketsWorld): Promise<void> {
    await closesOn(this, "Trip", -1);
  },
);

Then(
  "the customer opening the {word} page is told registration is closed",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openBookingPage(listingNamed(this, name));
    expect(browser.pageText).toContain(t("public.ticket.registration_closed"));
  },
);

Then(
  "the page offers no way to book",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openBookingPage(listingNamed(this, "Trip"));
    expect(browser.currentHtml).not.toContain("Continue");
  },
);

Then(
  "the customer can fill the {word} page in",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // Filling the page in, not merely reading it: the premise of every
    // closed-page claim is that this page was bookable until the moment.
    await visitorFillsInBooking(listingNamed(this, name), THE_CUSTOMER);
  },
);

/** The page selling the Trip and the Mug together, opened fresh. Every read
 * of the pair goes through here, so the two things being sold together are
 * named in one place. */
const openTripAndMugPage = (world: TicketsWorld) =>
  openAsNewcomer(
    `/ticket/${listingNamed(world, "Trip").slug}+${
      listingNamed(world, "Mug").slug
    }`,
  );

/** The part of the page between the Trip's own closed row and the Mug's own
 * booking control — a closed label found there belongs to the Trip's row,
 * not to a marker somewhere else on the page. An open listing renders its
 * name with its controls inside one label, so the Mug's quantity field is
 * the reliable edge of its row. */
const tripRowOn = (html: string, mugField: string): string => {
  const start = html.indexOf("<label>Trip</label>");
  const end = html.indexOf(mugField);
  if (start < 0 || end < start) {
    throw new Error(
      "The page shows no closed Trip row in front of the Mug's controls",
    );
  }
  return html.slice(start, end);
};

Then(
  "the page selling both says the Trip is closed",
  async function (this: TicketsWorld): Promise<void> {
    const { currentHtml } = await openTripAndMugPage(this);
    const mugField = `name="${quantityFieldName(
      listingNamed(this, "Mug").id,
    )}"`;
    expect(tripRowOn(currentHtml, mugField)).toContain(
      t("public.registration_closed"),
    );
  },
);

Then(
  "the page still lets the customer book the Mug",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openTripAndMugPage(this);
    const mug = listingNamed(this, "Mug");
    expect(
      whyValueCannotBeSent(browser.currentHtml, quantityFieldName(mug.id), "1"),
    ).toBeNull();
  },
);

Then(
  "the page selling both is closed to booking",
  async function (this: TicketsWorld): Promise<void> {
    const { currentHtml } = await openTripAndMugPage(this);
    expect(currentHtml).toContain(t("public.ticket.registration_closed"));
    // Closed to booking means nothing to book with: no count for either
    // thing, and no button to send anything.
    for (const name of ["Trip", "Mug"]) {
      expect(currentHtml).not.toContain(
        `name="${quantityFieldName(listingNamed(this, name).id)}"`,
      );
    }
    expect(currentHtml).not.toContain("Continue");
  },
);

Then(
  "the customer is told registration closed while they were submitting",
  function (this: TicketsWorld): void {
    expect(sentOrder(this).browser.pageText).toContain(
      REGISTRATION_CLOSED_SUBMIT_MESSAGE,
    );
  },
);

Then(
  "nothing was booked on the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect((await getAttendeesRaw(listingNamed(this, name).id)).length).toBe(0);
  },
);

Then(
  "one place was booked on the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // A thanked order is only half the proof: an order that silently dropped
    // one of its lines would thank its customer just the same, and so would
    // a line that booked the wrong number of places.
    const booked = await getAttendeesRaw(listingNamed(this, name).id);
    expect(booked.length).toBe(1);
    expect(booked[0]?.quantity).toBe(1);
  },
);
