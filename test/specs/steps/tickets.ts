// jscpd:ignore-start

import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  customerBuysBundles,
  organiserSellsAsBundle,
  thingsGroupedTogether,
} from "#test/specs/support/bundles.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  A_MADE_UP_CODE,
  askForAMadeUpCode,
  customerBooksTheirDay,
  customerOrders,
  customerPaysForOnePlace,
  everyCodeCollected,
  headingForTickets,
  openTicket,
  sellsSomethingByTheDay,
  sellsSomethingFilledIn,
  theDayTheyPicked,
  theirLinkCarries,
  wordsOnTheirTicket,
} from "#test/specs/support/tickets.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The words on the ticket the person is holding, for every Then that reads
 * one. Each read opens the link again, so every assertion is made against a
 * link that still works. */
const ticketWords = (world: TicketsWorld): Promise<string> =>
  wordsOnTheirTicket(world);

Given(
  "the site sells a {word}, filled in with",
  async function (
    this: TicketsWorld,
    name: string,
    filledIn: DataTable,
  ): Promise<void> {
    await sellsSomethingFilledIn(this, name, filledIn.rowsHash());
  },
);

Given(
  "the site sells a {word} by the day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await sellsSomethingByTheDay(this, name);
  },
);

/** A bundle of one thing, sold under its own name, with what is inside it
 * either concealed or on show. Both are built through the organiser's own
 * group form, so a bundle the site would refuse to make cannot be set up. */
const bundleOfOneThing = async (
  world: TicketsWorld,
  bundle: string,
  part: string,
  options: { handsOut?: string; keepPartsPrivate: boolean },
): Promise<void> => {
  await thingsGroupedTogether(world, bundle, [
    {
      name: part,
      ownPrice: 0,
      ...(options.handsOut === undefined ? {} : { handsOut: options.handsOut }),
    },
  ]);
  await organiserSellsAsBundle(
    world,
    bundle,
    [{ name: part }],
    options.keepPartsPrivate,
  );
};

Given(
  "a private {word} bundle holding a {word}",
  function (this: TicketsWorld, bundle: string, part: string): Promise<void> {
    return bundleOfOneThing(this, bundle, part, { keepPartsPrivate: true });
  },
);

Given(
  "an open {word} bundle holding a {word} with {string} to hand out",
  function (
    this: TicketsWorld,
    bundle: string,
    part: string,
    handsOut: string,
  ): Promise<void> {
    return bundleOfOneThing(this, bundle, part, {
      handsOut,
      keepPartsPrivate: false,
    });
  },
);

When(
  "{word} books {int} place(s) on the {word}",
  function (
    this: TicketsWorld,
    who: string,
    places: number,
    name: string,
  ): Promise<void> {
    return customerOrders(this, who, [{ name, places }]);
  },
);

When(
  "{word} orders {int} place(s) on the {word} and {int} on the {word}",
  function (
    this: TicketsWorld,
    who: string,
    firstPlaces: number,
    first: string,
    secondPlaces: number,
    second: string,
  ): Promise<void> {
    return customerOrders(this, who, [
      { name: first, places: firstPlaces },
      { name: second, places: secondPlaces },
    ]);
  },
);

When(
  "{word} books the {word} for the day they picked",
  function (this: TicketsWorld, who: string, name: string): Promise<void> {
    return customerBooksTheirDay(this, who, name);
  },
);

When(
  "{word} pays {float} for a place on the {word}",
  function (
    this: TicketsWorld,
    who: string,
    pounds: number,
    name: string,
  ): Promise<void> {
    return customerPaysForOnePlace(
      this,
      who,
      name,
      minorUnits(pounds.toFixed(2)),
    );
  },
);

When(
  "{word} buys {int} of the {word}",
  function (
    this: TicketsWorld,
    _who: string,
    howMany: number,
    bundle: string,
  ): Promise<void> {
    return customerBuysBundles(this, bundle, howMany);
  },
);

/** The one code somebody is holding, for the Scenarios that then ask for it in
 * an odd way. More than one would make "that ticket" ambiguous, so it says so
 * rather than picking whichever came first. */
const theOneCodeTheyHold = (world: TicketsWorld): string => {
  const [code, ...rest] = everyCodeCollected(world);
  if (!code || rest.length > 0) {
    throw new Error("The story has no single ticket to ask for");
  }
  return code;
};

When(
  "{word} asks for that ticket twice over in one link",
  function (this: TicketsWorld, _who: string): void {
    const code = theOneCodeTheyHold(this);
    theirLinkCarries(this, [code, code]);
  },
);

When(
  "{word} asks for that ticket alongside a made-up code",
  function (this: TicketsWorld, _who: string): void {
    theirLinkCarries(this, [theOneCodeTheyHold(this), A_MADE_UP_CODE]);
  },
);

When(
  "{word} asks for every ticket in one link",
  function (this: TicketsWorld, _who: string): void {
    theirLinkCarries(this, everyCodeCollected(this));
  },
);

When(
  "somebody opens a made-up ticket code",
  async function (this: TicketsWorld): Promise<void> {
    const { answered, said } = await askForAMadeUpCode();
    this.firstStatus = answered;
    this.firstBody = said;
  },
);

Then(
  "{word} is holding {int} ticket(s)",
  async function (
    this: TicketsWorld,
    _who: string,
    count: number,
  ): Promise<void> {
    expect(await ticketWords(this)).toContain(headingForTickets(count));
  },
);

Then(
  "the ticket names the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await ticketWords(this)).toContain(name);
  },
);

Then(
  "the ticket never names the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await ticketWords(this)).not.toContain(name);
  },
);

Then(
  "the ticket says {int} place(s) was/were taken",
  async function (this: TicketsWorld, places: number): Promise<void> {
    expect(await ticketWords(this)).toContain(
      `${t("tickets.quantity")} ${places}`,
    );
  },
);

Then(
  "the ticket says {int} of them were bought",
  async function (this: TicketsWorld, howMany: number): Promise<void> {
    // A private bundle counts what was bought without naming a single part,
    // so the whole bundle carries one count rather than a quantity per part.
    expect(await ticketWords(this)).toContain(`\u00d7${howMany}`);
  },
);

Then(
  "the ticket says it is on {string} at {string}",
  async function (
    this: TicketsWorld,
    day: string,
    place: string,
  ): Promise<void> {
    const words = await ticketWords(this);
    expect(words).toContain(day);
    expect(words).toContain(place);
  },
);

Then(
  "the ticket describes it as {string}",
  async function (this: TicketsWorld, description: string): Promise<void> {
    expect(await ticketWords(this)).toContain(description);
  },
);

Then(
  "the ticket says it may not be passed on",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).toContain(t("tickets.non_transferable"));
  },
);

Then(
  "the ticket offers {string} to download",
  async function (this: TicketsWorld, file: string): Promise<void> {
    const browser = await openTicket(this);
    expect(browser.pageText).toContain(`${t("tickets.download")} ${file}`);
    // A name with no link behind it is a file nobody can open, so the way in
    // has to be there too.
    const toFile = browser.links.find(({ href }) =>
      href.startsWith("/attachment/"),
    );
    if (!toFile) throw new Error(`The ticket offers no way to open ${file}`);
  },
);

/** Nothing the organiser left blank shows on the ticket. The blocks holding
 * when and where a thing is, and what it is, carry no wording of their own —
 * their own markup is the only thing that can prove they are absent. */
const expectNoBlock = async (
  world: TicketsWorld,
  block: string,
): Promise<void> => {
  expect((await openTicket(world)).currentHtml).not.toContain(block);
};

Then(
  "the ticket says nothing about when or where it is",
  async function (this: TicketsWorld): Promise<void> {
    await expectNoBlock(this, "ticket-card-date");
    await expectNoBlock(this, "ticket-card-location");
  },
);

Then(
  "the ticket describes nothing",
  function (this: TicketsWorld): Promise<void> {
    return expectNoBlock(this, "ticket-card-description");
  },
);

Then(
  "the ticket says nothing about being passed on",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).not.toContain(
      t("tickets.non_transferable"),
    );
  },
);

Then(
  "the ticket offers nothing to download",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).not.toContain(t("tickets.download"));
  },
);

Then(
  "the ticket says {float} was paid",
  async function (this: TicketsWorld, pounds: number): Promise<void> {
    expect(await ticketWords(this)).toContain(
      `${t("tickets.price")} ${formatCurrency(minorUnits(pounds.toFixed(2)))}`,
    );
  },
);

Then(
  "the ticket says nothing about a price",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).not.toContain(t("tickets.price"));
  },
);

Then(
  "the ticket says it is booked for the day they picked",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).toContain(
      `${t("tickets.booking_date")} ${formatDateLabel(theDayTheyPicked(this))}`,
    );
  },
);

Then(
  "the ticket gives no booked day",
  async function (this: TicketsWorld): Promise<void> {
    expect(await ticketWords(this)).not.toContain(t("tickets.booking_date"));
  },
);

Then(
  "the ticket prints the code {word} was given",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    expect(await ticketWords(this)).toContain(theOneCodeTheyHold(this));
  },
);

Then(
  "the ticket shows a picture of that code to scan",
  async function (this: TicketsWorld): Promise<void> {
    // The picture is fetched from an address of its own, so the ticket page
    // stays small and the door's code can be cached like any other image.
    expect((await openTicket(this)).currentHtml).toContain(
      `src="/t/${theOneCodeTheyHold(this)}/svg"`,
    );
  },
);

Then(
  "the site tells them there is no such page",
  function (this: TicketsWorld): void {
    expect(requiredWorldValue(this.firstStatus, "what the site answered")).toBe(
      404,
    );
    expect(requiredWorldValue(this.firstBody, "what the site said")).toContain(
      t("public.not_found.heading"),
    );
  },
);
