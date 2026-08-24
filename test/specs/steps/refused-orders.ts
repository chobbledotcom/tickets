/**
 * Orders the site refuses, and what a refusal leaves behind. One family of
 * steps fills a page in, lets somebody quicker take a place, and then reads
 * the refused page back — the reason, the untouched bookings, and everything
 * the customer typed still filled in.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { customPriceFieldName, quantityFieldName } from "#booking/tree.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { TICKETS_UNAVAILABLE_MESSAGE } from "#routes/public/ticket-submit/paths.ts";
import {
  addAnswer,
  assignQuestion,
} from "#test/shared/db/questions/helpers.ts";
import {
  browserSeenBy,
  CUSTOMER as CUSTOMERS_BROWSER,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  answerTicked,
  attribute,
  boxFor,
  boxOffered,
  chooserFor,
  optionChosen,
} from "#test/specs/support/form-controls/reading.ts";
import {
  listingIdNamed,
  listingNamed,
  rememberListing,
  sellSomethingAt,
} from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  type BookingAttempt,
  type BookingChoices,
  daysOfferedFor,
  daysOfferedOn,
  expectRefusedForWantOfRoom,
  type OrderInHand,
  type OrderLine,
  visitorFillsInOrder,
  visitorTriesToBook,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const THE_CUSTOMER = { email: "jane@example.com", who: "Jane Doe" };
const SOMEONE_QUICKER = { email: "quicker@example.com", who: "Kit Quick" };

/** The question this scenario's listing asks, or a loud failure. */
type QuestionAsked = NonNullable<TicketsWorld["questionChoices"]>;
const questionAsked = (world: TicketsWorld): QuestionAsked =>
  requiredWorldValue(world.questionChoices, "the question the listing asks");

/** The choice sent by answering with these words, or a loud failure when the
 * question never offered them. */
const choiceCalled = (asked: QuestionAsked, label: string): string =>
  requiredWorldValue(asked.byLabel[label], `the "${label}" answer`);

/** A choice that is not the customer's own, so a tick that survives the
 * refusal can only be theirs. */
const choiceUnlikeTheirs = (asked: QuestionAsked, theirs?: string): string => {
  const other = Object.values(asked.byLabel).find(
    (choice) => choice !== theirs,
  );
  if (!other) throw new Error("The question offers no second answer to pick");
  return other;
};

/** Fill a served page in and keep the unsent order, with what was typed into
 * it, so the story can race somebody past it and read the refill back. */
const fillsIn = async (
  world: TicketsWorld,
  path: string,
  lines: OrderLine[],
  choices: BookingChoices,
): Promise<void> => {
  const { press } = await visitorFillsInOrder(path, lines, choices);
  world.orderFilledIn = { choices, lines, press };
};

/** The page several listings are booked from together. */
const combinedPath = (lines: OrderLine[]): string =>
  `/ticket/${lines.map(({ listing }) => listing.slug).join("+")}`;

const orderInHand = (world: TicketsWorld): OrderInHand =>
  requiredWorldValue(world.orderFilledIn, "the filled-in order");

const sentOrder = (world: TicketsWorld): BookingAttempt =>
  requiredWorldValue(world.orderSent, "what the site said to the order");

/** The page the refusal handed back, with the typed values re-filled. */
const refillPage = (world: TicketsWorld): string =>
  sentOrder(world).browser.currentHtml;

/** What a box on the refused page still holds, or a loud failure when the
 * page stopped rendering the box at all. */
const wordsInBox = (html: string, field: string): string => {
  const box = boxFor(html, field);
  if (!box) throw new Error(`The page has no ${field} box`);
  return attribute(box, "value") ?? "";
};

/** A plain thing for sale with its own thank-you page, remembered by name. */
const sellPlainThing = async (
  world: TicketsWorld,
  name: string,
  room: number,
): Promise<void> => {
  rememberListing(
    world,
    name,
    await createTestListing({
      maxAttendees: room,
      maxQuantity: Math.min(room, 5),
      name,
      thankYouUrl: "",
    }),
  );
};

/** A thing booked by the day, remembered by name, with the extras a story's
 * own listing needs — a chosen price, a bigger order. */
const sellDayBookedThing = async (
  world: TicketsWorld,
  name: string,
  placesADay: number,
  extras: Parameters<typeof createDailyTestListing>[0] = {},
): Promise<void> => {
  rememberListing(
    world,
    name,
    await createDailyTestListing({
      maxAttendees: placesADay,
      maxQuantity: placesADay,
      name,
      thankYouUrl: "",
      ...extras,
    }),
  );
};

Given(
  "the shop sells an Alpha and a Bravo, and a Charlie booked by the day with room for {int} a day",
  async function (this: TicketsWorld, room: number): Promise<void> {
    await sellPlainThing(this, "Alpha", 10);
    await sellPlainThing(this, "Bravo", 10);
    await sellDayBookedThing(this, "Charlie", room);
  },
);

Given(
  "a Donation booked by the day that lets customers pay what they like, with room for {int} places a day",
  async function (this: TicketsWorld, room: number): Promise<void> {
    // The refusal comes before any money moves, but a chosen price makes the
    // order a paid one, so the site needs its payment provider set up.
    await setupStripe();
    await sellDayBookedThing(this, "Donation", room, {
      canPayMore: true,
      maxPrice: minorUnits("100.00"),
      unitPrice: 0,
    });
  },
);

Given(
  "a Workshop booked by the day with room for {int} places a day that asks {string} with the answers {string} and {string}",
  async function (
    this: TicketsWorld,
    room: number,
    question: string,
    firstAnswer: string,
    secondAnswer: string,
  ): Promise<void> {
    await sellDayBookedThing(this, "Workshop", room);
    const asked = await assignQuestion(
      listingIdNamed(this, "Workshop"),
      question,
      firstAnswer,
    );
    const second = await addAnswer(asked.question.id, 1, secondAnswer);
    this.questionChoices = {
      byLabel: {
        [firstAnswer]: String(asked.answer.id),
        [secondAnswer]: String(second.id),
      },
      field: `question_${asked.question.id}`,
    };
  },
);

Given(
  "a Ticket to book, where orders must agree to terms first",
  async function (this: TicketsWorld): Promise<void> {
    await sellPlainThing(this, "Ticket", 10);
    await settings.update.terms("You must accept the rules to book.");
  },
);

Given(
  "the shop also sells a Mug",
  async function (this: TicketsWorld): Promise<void> {
    await sellSomethingAt(this, "Mug", "0.00", { keepThankYouPage: true });
  },
);

Given(
  "the shop sells a Choir open only on Mondays and a Pilates open only on Tuesdays",
  async function (this: TicketsWorld): Promise<void> {
    const openOn = [
      ["Choir", "Monday"],
      ["Pilates", "Tuesday"],
    ] as const;
    for (const [name, day] of openOn) {
      rememberListing(
        this,
        name,
        await createTestListing({
          bookableDays: [day],
          listingType: "daily",
          maximumDaysAfter: 21,
          minimumDaysBefore: 0,
          name,
          thankYouUrl: "",
        }),
      );
    }
  },
);

/** The first day a listing's own page offers, or a loud failure — "a day
 * soon" in a story is a day the site really offers. */
const firstDayOffered = async (world: TicketsWorld, name: string) => {
  const [day] = await daysOfferedFor(listingNamed(world, name));
  if (!day) throw new Error(`The ${name} offers no day to book`);
  return day;
};

Given(
  "a customer filled the page selling all three in, asking for 3 Alpha, no Bravo, and the last Charlie for a day soon",
  async function (this: TicketsWorld): Promise<void> {
    // The Charlie leads the page: a capacity refusal names the order's first
    // listing, so a later full line is misnamed (see TODO.md).
    const lines = [
      { listing: listingNamed(this, "Charlie"), places: 1 },
      { listing: listingNamed(this, "Alpha"), places: 3 },
      { listing: listingNamed(this, "Bravo"), places: 0 },
    ];
    await fillsIn(this, combinedPath(lines), lines, {
      ...THE_CUSTOMER,
      day: await firstDayOffered(this, "Charlie"),
    });
  },
);

Given(
  "a customer filled the {word} page in, asking for {int} place(s) for a day soon and choosing to pay {word}",
  async function (
    this: TicketsWorld,
    name: string,
    places: number,
    pounds: string,
  ): Promise<void> {
    const listing = listingNamed(this, name);
    const lines = [{ listing, pays: pounds.replace("£", ""), places }];
    await fillsIn(this, `/ticket/${listing.slug}`, lines, {
      ...THE_CUSTOMER,
      day: await firstDayOffered(this, name),
    });
  },
);

Given(
  "a customer filled the {word} page in, asking for {int} place(s) starting in {int} days",
  async function (
    this: TicketsWorld,
    name: string,
    places: number,
    startsIn: number,
  ): Promise<void> {
    const listing = listingNamed(this, name);
    await fillsIn(this, `/ticket/${listing.slug}`, [{ listing, places }], {
      ...THE_CUSTOMER,
      day: dayFromToday(this, startsIn),
    });
  },
);

Given(
  "a customer filled the {word} page in, asking for {int} place(s) on a {int}-day stay starting in {int} days",
  async function (
    this: TicketsWorld,
    name: string,
    places: number,
    days: number,
    startsIn: number,
  ): Promise<void> {
    const listing = listingNamed(this, name);
    await fillsIn(this, `/ticket/${listing.slug}`, [{ listing, places }], {
      ...THE_CUSTOMER,
      day: dayFromToday(this, startsIn),
      dayCount: days,
    });
  },
);

Given(
  "a customer filled the {word} page in, asking for {int} place(s) for a day soon and answering {string}",
  async function (
    this: TicketsWorld,
    name: string,
    places: number,
    label: string,
  ): Promise<void> {
    const listing = listingNamed(this, name);
    const asked = questionAsked(this);
    await fillsIn(this, `/ticket/${listing.slug}`, [{ listing, places }], {
      ...THE_CUSTOMER,
      answer: { choice: choiceCalled(asked, label), field: asked.field },
      day: await firstDayOffered(this, name),
    });
  },
);

Given(
  "a customer filled the page selling the Mug and the Ferry in, for a day soon",
  async function (this: TicketsWorld): Promise<void> {
    // The Ferry leads the page: a capacity refusal names the order's first
    // listing, so a later full line is misnamed (see TODO.md).
    const lines = [
      { listing: listingNamed(this, "Ferry"), places: 1 },
      { listing: listingNamed(this, "Mug"), places: 1 },
    ];
    await fillsIn(this, combinedPath(lines), lines, {
      ...THE_CUSTOMER,
      day: await firstDayOffered(this, "Ferry"),
    });
  },
);

When(
  "another customer takes {int} {word} place(s) first",
  async function (
    this: TicketsWorld,
    places: number,
    name: string,
  ): Promise<void> {
    const { choices } = orderInHand(this);
    const asked = this.questionChoices;
    const { wasBooked } = await visitorTriesToBook(listingNamed(this, name), {
      ...SOMEONE_QUICKER,
      places,
      ...(choices.day === undefined ? {} : { day: choices.day }),
      // A stay whose length is the customer's to pick needs one from this
      // customer too; the shortest keeps the race about room.
      ...(choices.dayCount === undefined ? {} : { dayCount: 1 }),
      // A listing with a question insists on an answer from every customer.
      ...(asked === undefined
        ? {}
        : {
            answer: {
              choice: choiceUnlikeTheirs(asked, choices.answer?.choice),
              field: asked.field,
            },
          }),
    });
    if (!wasBooked) {
      throw new Error(
        `The other customer could not take the ${name} place, so the race never happened`,
      );
    }
  },
);

When("the customer sends the form", async function (this: TicketsWorld) {
  this.orderSent = await orderInHand(this).press();
});

When(
  "a customer sends the form agreeing to the terms but asking for nothing",
  async function (this: TicketsWorld): Promise<void> {
    const listing = listingNamed(this, "Ticket");
    this.orderSent = await visitorTriesToOrder(
      `/ticket/${listing.slug}`,
      [{ listing, places: 0 }],
      { ...THE_CUSTOMER, agreesToTerms: true },
    );
  },
);

When(
  "a customer opens the page selling both together",
  async function (this: TicketsWorld): Promise<void> {
    const lines = [
      { listing: listingNamed(this, "Choir") },
      { listing: listingNamed(this, "Pilates") },
    ];
    rememberBrowser(
      this,
      CUSTOMERS_BROWSER,
      await openAsNewcomer(combinedPath(lines)),
    );
  },
);

Then(
  "the customer is told the {word} no longer has enough room",
  function (this: TicketsWorld, name: string): void {
    expectRefusedForWantOfRoom(sentOrder(this), listingNamed(this, name).name);
  },
);

Then(
  "the customer is told the tickets are no longer available",
  function (this: TicketsWorld): void {
    const attempt = sentOrder(this);
    expect(attempt.wasBooked).toBe(false);
    expect(attempt.browser.pageText).toContain(TICKETS_UNAVAILABLE_MESSAGE);
  },
);

Then(
  "the page still has {int} chosen for the Alpha and none for the Bravo",
  function (this: TicketsWorld, count: number): void {
    const html = refillPage(this);
    expect(
      optionChosen(html, quantityFieldName(listingIdNamed(this, "Alpha"))),
    ).toBe(String(count));
    expect(
      optionChosen(html, quantityFieldName(listingIdNamed(this, "Bravo"))),
    ).toBe("0");
  },
);

Then(
  "the customer's name and email are still typed in",
  function (this: TicketsWorld): void {
    const html = refillPage(this);
    expect(wordsInBox(html, "name")).toBe(THE_CUSTOMER.who);
    expect(wordsInBox(html, "email")).toBe(THE_CUSTOMER.email);
  },
);

Then(
  "the {word} the customer chose to pay is still filled in",
  function (this: TicketsWorld, pounds: string): void {
    const paying = orderInHand(this).lines.find(
      (line) => line.pays !== undefined,
    );
    if (!paying) throw new Error("No price was typed into this order");
    expect(
      wordsInBox(refillPage(this), customPriceFieldName(paying.listing.id)),
    ).toBe(pounds.replace("£", ""));
  },
);

Then(
  "the day the customer picked is still chosen",
  function (this: TicketsWorld): void {
    const day = requiredWorldValue(
      orderInHand(this).choices.day,
      "the day the customer picked",
    );
    expect(optionChosen(refillPage(this), "date")).toBe(day);
  },
);

Then(
  "the {int}-day stay the customer picked is still chosen",
  function (this: TicketsWorld, days: number): void {
    expect(optionChosen(refillPage(this), "day_count")).toBe(String(days));
  },
);

Then(
  "the customer's answer {string} is still picked",
  function (this: TicketsWorld, label: string): void {
    const asked = questionAsked(this);
    expect(answerTicked(refillPage(this), asked.field)).toBe(
      choiceCalled(asked, label),
    );
  },
);

Then("the terms box is still ticked", function (this: TicketsWorld): void {
  expect(boxOffered(refillPage(this), "agree_terms").ticked).toBe(true);
});

Then(
  "the customer is told to pick at least one thing",
  function (this: TicketsWorld): void {
    const attempt = sentOrder(this);
    expect(attempt.wasBooked).toBe(false);
    // The site's exact words, from src/features/public/ticket-submit/prepare.ts.
    expect(attempt.browser.pageText).toContain(
      "Please select at least one ticket",
    );
  },
);

Then(
  "nothing was booked for the customer — no Mug and no Ferry",
  async function (this: TicketsWorld): Promise<void> {
    // A refusal must leave nothing behind: the Mug line fitted on its own, so
    // any Mug row means the refused order leaked half of itself.
    expect((await getAttendeesRaw(listingIdNamed(this, "Mug"))).length).toBe(0);
    // The Ferry keeps only the other customer's booking.
    expect((await getAttendeesRaw(listingIdNamed(this, "Ferry"))).length).toBe(
      1,
    );
  },
);

Then(
  "the customer is told no days are available",
  function (this: TicketsWorld): void {
    const browser = browserSeenBy(this, CUSTOMERS_BROWSER);
    expect(browser.pageText).toContain(t("public.ticket.no_dates_available"));
  },
);

Then("the page offers no day to pick", function (this: TicketsWorld): void {
  const { currentHtml } = browserSeenBy(this, CUSTOMERS_BROWSER);
  // A page that renders no date chooser at all offers no day either.
  const offered =
    chooserFor(currentHtml, "date") === null ? [] : daysOfferedOn(currentHtml);
  expect(offered).toEqual([]);
});
