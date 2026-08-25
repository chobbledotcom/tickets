/**
 * Agreeing to the site's terms before an order goes through: what the page
 * shows, that it insists on the agreement before it will send, and what an
 * agreement covers. The server's own refusal of an order that arrives
 * without the agreement is a crafted POST no browser can make — the page's
 * checkbox is required — so it lives in the direct suite.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { boxOffered } from "#test/specs/support/form-controls/reading.ts";
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

/** The box a customer ticks to agree, read from the page by its own label
 * when the story needs it (the catalog is not loaded at import time). */
const agreeBoxLabel = (): string => t("public.ticket.agree_terms");

/** The page selling the Ticket and the Mug together, opened fresh. */
const openTicketAndMugPage = (world: TicketsWorld) =>
  openAsNewcomer(
    combinedPath(
      [listingNamed(world, "Ticket"), listingNamed(world, "Mug")].map(
        (listing) => ({ listing, places: 1 }),
      ),
    ),
  );

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
  "the page selling both shows the terms and a box to agree to them",
  async function (this: TicketsWorld): Promise<void> {
    const { currentHtml } = await openTicketAndMugPage(this);
    expect(currentHtml).toContain(await settings.terms);
    expect(currentHtml).toContain(agreeBoxLabel());
    expect(currentHtml).toContain('name="agree_terms"');
  },
);

Then(
  "the {word} page offers no box to agree to",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const html = (await openBookingPage(listingNamed(this, name))).currentHtml;
    expect(html).not.toContain('name="agree_terms"');
  },
);

Then(
  "the {word} page insists the terms box is ticked before it will send",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const html = (await openBookingPage(listingNamed(this, name))).currentHtml;
    // A browser will not send a form with a required box clear, so the
    // insistence is what stops a real customer — the server's own refusal
    // of an order that arrives without the agreement is the direct suite's.
    expect(boxOffered(html, "agree_terms").insisted).toBe(true);
  },
);

Then(
  "the page selling both insists the terms box is ticked before it will send",
  async function (this: TicketsWorld): Promise<void> {
    const { currentHtml } = await openTicketAndMugPage(this);
    expect(boxOffered(currentHtml, "agree_terms").insisted).toBe(true);
  },
);

/** The customer asks for one place on this thing, with or without the
 * agreement. */
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
  "a customer tries to order the Ticket and the Mug agreeing to the terms",
  async function (this: TicketsWorld): Promise<void> {
    const lines = [listingNamed(this, "Ticket"), listingNamed(this, "Mug")].map(
      (listing) => ({ listing, places: 1 }),
    );
    this.orderSent = await visitorTriesToOrder(combinedPath(lines), lines, {
      ...THE_CUSTOMER,
      agreesToTerms: true,
    });
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
