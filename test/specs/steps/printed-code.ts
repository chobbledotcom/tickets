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
  "the organiser makes a code for the {word} for {word} at {float}",
  async function (
    this: TicketsWorld,
    name: string,
    who: string,
    price: number,
  ): Promise<void> {
    this.printedCodeListing = name;
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
    this.printedCodeListing = name;
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
    const name = requiredWorldValue(this.printedCodeListing, "the listing");
    const led = whereItLed(this);
    // What they end up paying replaces what the code alone would have charged,
    // so the story reads the answer from one place either way.
    led.priceEach = await customerPaysMore(this, name, led.page, price);
    led.sentToPay = true;
  },
);

Then(
  "the customer is sent straight off to pay",
  function (this: TicketsWorld): void {
    expect(whereItLed(this).sentToPay).toBe(true);
  },
);

Then(
  "the customer is not sent off to pay",
  function (this: TicketsWorld): void {
    expect(whereItLed(this).sentToPay).toBe(false);
  },
);

Then(
  "they are asked for {float}",
  function (this: TicketsWorld, price: number): void {
    expect(whereItLed(this).priceEach).toBe(inPennies(price));
  },
);

Then(
  "the form is already filled in with the name {word}",
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
    expect(led.sentToPay).toBe(false);
    expect(led.page).toContain("expired or invalid");
  },
);

Then(
  "the customer cannot open it at all",
  function (this: TicketsWorld): void {
    const led = whereItLed(this);
    expect(led.sentToPay).toBe(false);
    expect(led.reached).toBe(false);
  },
);

Then(
  "nothing was booked for the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectNothingBooked(this, name);
  },
);
