// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  customerFollows,
  customerPaysMore,
  expectNothingBooked,
  meddledWith,
  organiserMakesCode,
  somethingForSale,
  takeOffSale,
} from "#test/specs/support/printed-code.ts";
import { stayListing } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Money as the story writes it, in the smallest units the site stores. */
const inPennies = (amount: number): number => Math.round(amount * 100);

/** Where the code the customer read took them. */
const whereItLed = (world: TicketsWorld) =>
  requiredWorldValue(world.codeLedTo, "where the code led");

/** What the customer is being asked to pay, once they have got that far. */
const payingNow = (world: TicketsWorld) => {
  const paying = whereItLed(world).paying;
  if (!paying) throw new Error("They were never asked to pay for anything");
  return paying;
};

Given(
  "a {word} is on sale at {float}",
  function (this: TicketsWorld, name: string, price: number): Promise<void> {
    return somethingForSale(this, name, { price: inPennies(price) });
  },
);

Given(
  "a {word} is on sale at {float}, and people may pay more",
  function (this: TicketsWorld, name: string, price: number): Promise<void> {
    return somethingForSale(this, name, {
      canPayMore: true,
      price: inPennies(price),
    });
  },
);

Given(
  "a {word} is on sale at {float}, and asks the customer for an email",
  function (this: TicketsWorld, name: string, price: number): Promise<void> {
    return somethingForSale(this, name, {
      askForEmail: true,
      price: inPennies(price),
    });
  },
);

When(
  "the organiser makes a code for the {word} for {string} at {float}",
  async function (
    this: TicketsWorld,
    name: string,
    who: string,
    price: number,
  ): Promise<void> {
    this.printedCode = await organiserMakesCode(this, name, { price, who });
  },
);

When(
  "the organiser makes a code for the {word} at {float}",
  async function (
    this: TicketsWorld,
    name: string,
    price: number,
  ): Promise<void> {
    this.printedCode = await organiserMakesCode(this, name, { price });
  },
);

When(
  "the organiser takes the {word} off sale",
  function (this: TicketsWorld, name: string): Promise<void> {
    return takeOffSale(this, name);
  },
);

/** The code the organiser printed, as it is about to be read. */
const printed = (world: TicketsWorld): string =>
  requiredWorldValue(world.printedCode, "the printed code");

When(
  "a customer reads that code",
  async function (this: TicketsWorld): Promise<void> {
    this.codeLedTo = await customerFollows(printed(this));
  },
);

When(
  "a customer reads that code after it has been changed",
  async function (this: TicketsWorld): Promise<void> {
    this.codeLedTo = await customerFollows(meddledWith(printed(this)));
  },
);

When(
  "the customer decides to pay {float} instead",
  async function (this: TicketsWorld, price: number): Promise<void> {
    // What they end up paying replaces what the code alone would have charged,
    // so the story reads the answer from one place either way.
    whereItLed(this).paying = await customerPaysMore(printed(this), price);
  },
);

Then(
  "the customer is sent straight off to pay",
  function (this: TicketsWorld): void {
    expect(whereItLed(this).paying).not.toBeNull();
  },
);

Then(
  "the booking form opens for them instead",
  function (this: TicketsWorld): void {
    const led = whereItLed(this);
    expect(led.paying).toBeNull();
    expect(led.status).toBe(200);
  },
);

Then(
  "they are asked for {float}",
  function (this: TicketsWorld, price: number): void {
    expect(payingNow(this).priceEach).toBe(inPennies(price));
  },
);

Then(
  "the form is already filled in with the name {string}",
  function (this: TicketsWorld, who: string): void {
    expect(whereItLed(this).page).toMatch(
      new RegExp(`name="name"[^>]*value="${who}"`),
    );
  },
);

Then(
  "the customer is told the code does not work",
  function (this: TicketsWorld): void {
    const led = whereItLed(this);
    expect(led.paying).toBeNull();
    expect(led.page).toContain("expired or invalid");
    // Anything reading the site rather than the page — a cache, a monitor —
    // goes by the answer's own code, so a refusal has to say it is one.
    expect(led.status).toBe(400);
  },
);

Then(
  "it is for {int} place(s)",
  function (this: TicketsWorld, places: number): void {
    expect(payingNow(this).places).toBe(places);
  },
);

Then("it is for the {word}", function (this: TicketsWorld, name: string): void {
  expect(payingNow(this).forWhat).toBe(stayListing(this, name).slug);
});

Then(
  "the booking is in the name {string}",
  function (this: TicketsWorld, who: string): void {
    expect(payingNow(this).nameOnIt).toBe(who);
  },
);

Then("the customer cannot open it at all", function (this: TicketsWorld): void {
  const led = whereItLed(this);
  expect(led.paying).toBeNull();
  expect(led.status).toBe(404);
});

Then(
  "nothing was booked for the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectNothingBooked(this, name);
  },
);
