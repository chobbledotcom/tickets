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
  boxOffered,
  chooserFor,
  optionChosen,
} from "#test/specs/support/form-controls/reading.ts";
import {
  listingIdNamed,
  listingNamed,
  putsOnSaleByTheDay,
  putsPlainThingOnSale,
  sellSomethingAt,
} from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  daysOfferedOn,
  expectRefusedForWantOfRoom,
  visitorTriesToBook,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import {
  choiceCalled,
  choiceUnlikeTheirs,
  combinedPath,
  fillsIn,
  fillsOwnPageIn,
  firstDayOffered,
  orderInHand,
  questionAsked,
  refillPage,
  SOMEONE_QUICKER,
  sellDayBookedThing,
  sentOrder,
  THE_CUSTOMER,
  wordsInBox,
} from "#test/specs/support/refused-orders.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

Given(
  "the shop sells an Alpha and a Bravo, and a Charlie booked by the day with room for {int} a day",
  async function (this: TicketsWorld, room: number): Promise<void> {
    await putsPlainThingOnSale(this, "Alpha");
    await putsPlainThingOnSale(this, "Bravo");
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
    await putsPlainThingOnSale(this, "Ticket");
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
      await putsOnSaleByTheDay(this, name, {
        bookableDays: [day],
        maximumDaysAfter: 21,
        minimumDaysBefore: 0,
        thankYouUrl: "",
      });
    }
  },
);

Given(
  "a customer filled the page selling all three in, asking for 3 Alpha, no Bravo, and the last Charlie for a day soon",
  async function (this: TicketsWorld): Promise<void> {
    // The Alpha leads the page, so the refusal naming the Charlie proves
    // the site names the thing that is full, not the order's first line.
    const lines = [
      { listing: listingNamed(this, "Alpha"), places: 3 },
      { listing: listingNamed(this, "Bravo"), places: 0 },
      { listing: listingNamed(this, "Charlie"), places: 1 },
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
    await fillsOwnPageIn(
      this,
      name,
      { pays: pounds.replace("£", ""), places },
      { day: await firstDayOffered(this, name) },
    );
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
    await fillsOwnPageIn(
      this,
      name,
      { places },
      { day: dayFromToday(this, startsIn) },
    );
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
    await fillsOwnPageIn(
      this,
      name,
      { places },
      { day: dayFromToday(this, startsIn), dayCount: days },
    );
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
    const asked = questionAsked(this);
    await fillsOwnPageIn(
      this,
      name,
      { places },
      {
        answer: { choice: choiceCalled(asked, label), field: asked.field },
        day: await firstDayOffered(this, name),
      },
    );
  },
);

Given(
  "a customer filled the page selling the Mug and the Ferry in, for a day soon",
  async function (this: TicketsWorld): Promise<void> {
    // The Mug leads the page, so the refusal naming the Ferry proves the
    // site names the thing that is full, not merely the order's first line.
    const lines = [
      { listing: listingNamed(this, "Mug"), places: 1 },
      { listing: listingNamed(this, "Ferry"), places: 1 },
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
