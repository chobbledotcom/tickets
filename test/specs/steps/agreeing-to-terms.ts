/**
 * Agreeing to the site's terms before an order goes through: what the page
 * shows, what a refusal says, and what an agreement covers.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  openBookingPage,
  THANK_YOU,
  visitorTriesToBook,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import {
  combinedPath,
  sentOrder,
  THE_CUSTOMER,
} from "#test/specs/support/refused-orders.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The site's refusal when the terms were never agreed to. The wording lives
 * beside the check that makes it, src/features/public/ticket-submit/parse.ts. */
const MUST_AGREE = "You must agree to the terms and conditions";

/** The box a customer ticks to agree, read from the page by its own label
 * when the story needs it (the catalog is not loaded at import time). */
const agreeBoxLabel = (): string => t("public.ticket.agree_terms");

Given(
  "a {word} to book",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await putsPlainThingOnSale(this, name);
  },
);

Then(
  "the {word} page shows the terms and a box to agree to them",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const html = (await openBookingPage(listingNamed(this, name))).currentHtml;
    // The site's own terms, exactly as the organiser wrote them, and the box
    // that carries the agreement — one is no good without the other.
    expect(html).toContain(await settings.terms);
    expect(html).toContain(agreeBoxLabel());
    expect(html).toContain('name="agree_terms"');
  },
);

Then(
  "the {word} page offers no box to agree to",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const html = (await openBookingPage(listingNamed(this, name))).currentHtml;
    expect(html).not.toContain('name="agree_terms"');
  },
);

/** The customer asks for one place on this thing, with or without the
 * agreement. One place is asked for, so a missing agreement is the only
 * thing standing between this customer and a booking. */
const triesToBookOne = async (
  world: TicketsWorld,
  name: string,
  extra: { agreesToTerms?: boolean } = {},
): Promise<void> => {
  world.orderSent = await visitorTriesToBook(listingNamed(world, name), {
    ...THE_CUSTOMER,
    places: 1,
    ...extra,
  });
};

When(
  "a customer tries to book the {word} without agreeing to the terms",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await triesToBookOne(this, name);
  },
);

When(
  "a customer tries to book the {word} agreeing to the terms",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await triesToBookOne(this, name, { agreesToTerms: true });
  },
);

When(
  "a customer tries to book the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await triesToBookOne(this, name);
  },
);

When(
  "a customer tries to order the Ticket and the Mug without agreeing to the terms",
  async function (this: TicketsWorld): Promise<void> {
    await orderTicketAndMug(this, false);
  },
);

When(
  "a customer tries to order the Ticket and the Mug agreeing to the terms",
  async function (this: TicketsWorld): Promise<void> {
    await orderTicketAndMug(this, true);
  },
);

/** One order covering the Ticket and the Mug, with or without the agreement. */
const orderTicketAndMug = async (
  world: TicketsWorld,
  agreesToTerms: boolean,
): Promise<void> => {
  const lines = [listingNamed(world, "Ticket"), listingNamed(world, "Mug")].map(
    (listing) => ({ listing, places: 1 }),
  );
  world.orderSent = await visitorTriesToOrder(combinedPath(lines), lines, {
    ...THE_CUSTOMER,
    agreesToTerms,
  });
};

Then(
  "the customer is told they must agree to the terms and conditions",
  function (this: TicketsWorld): void {
    const attempt = sentOrder(this);
    expect(attempt.wasBooked).toBe(false);
    expect(attempt.browser.pageText).toContain(MUST_AGREE);
  },
);

Then(
  "the customer is thanked for their order",
  function (this: TicketsWorld): void {
    const attempt = sentOrder(this);
    expect(attempt.wasBooked).toBe(true);
    expect(attempt.browser.pageText).toContain(THANK_YOU);
  },
);
