// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  listMarksStateAs,
  listShowsDeposit,
  markersOnRow,
  organiserAddsState,
  organiserHasAddedState,
  organiserMovesStateUp,
  organiserTakesStateAway,
  stateIsOfferedAMoveUp,
  statesOffered,
} from "#test/specs/support/statuses.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the organiser has added a state called {string}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return organiserHasAddedState(this, name);
  },
);

Given(
  "the organiser has added states called {string} and {string}",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
  ): Promise<void> {
    await organiserHasAddedState(this, first);
    await organiserHasAddedState(this, second);
  },
);

When(
  "the organiser adds a state called {string}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return organiserAddsState(this, { name });
  },
);

When(
  "the organiser adds a state called {string} asking for {string} up front",
  function (this: TicketsWorld, name: string, deposit: string): Promise<void> {
    return organiserAddsState(this, { deposit, name });
  },
);

When(
  "the organiser adds a state called {string} asking for {string} up front and meaning the balance is paid",
  function (this: TicketsWorld, name: string, deposit: string): Promise<void> {
    return organiserAddsState(this, {
      deposit,
      meansTheBalanceIsPaid: true,
      name,
    });
  },
);

When(
  "the organiser adds a state called {string} that is {string}",
  function (this: TicketsWorld, name: string, job: string): Promise<void> {
    return organiserAddsState(this, { job, name });
  },
);

Then(
  "{string} is one of the states a booking can be in",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await statesOffered(this)).toContain(name);
  },
);

Then(
  "there is no state called {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await statesOffered(this)).not.toContain(name);
  },
);

Then(
  "the list shows {string} asking for {string} up front",
  async function (
    this: TicketsWorld,
    name: string,
    amount: string,
  ): Promise<void> {
    expect(await listShowsDeposit(this, name, amount)).toBe(true);
  },
);

Then(
  "the organiser is told what a deposit can look like",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      RESERVATION_AMOUNT_HINT,
    );
  },
);

Then(
  "the organiser is told a paid state cannot also ask for a deposit",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "A paid status can't also be a reservation",
    );
  },
);

Then(
  "the list marks {string} as {string}",
  async function (
    this: TicketsWorld,
    name: string,
    job: string,
  ): Promise<void> {
    expect(await listMarksStateAs(this, name, job)).toBe(true);
  },
);

Then(
  "the list puts no marker beside {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await markersOnRow(this, name)).toEqual([]);
  },
);

Then(
  "the list no longer marks {string} as {string}",
  async function (
    this: TicketsWorld,
    name: string,
    job: string,
  ): Promise<void> {
    expect(await listMarksStateAs(this, name, job)).toBe(false);
  },
);

When(
  "the organiser takes {string} away, typing {string}",
  function (this: TicketsWorld, name: string, typed: string): Promise<void> {
    return organiserTakesStateAway(this, name, typed);
  },
);

Then(
  "the organiser is told the name does not match",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Name does not match. Please type the exact name to confirm deletion.",
    );
  },
);

Then(
  "the organiser is told at least one state must be kept",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "You must keep at least one status",
    );
  },
);

Then(
  "the organiser is told to choose another starting state first",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Choose another public default before deleting this status",
    );
  },
);

When(
  "the organiser moves {string} up",
  function (this: TicketsWorld, name: string): Promise<void> {
    return organiserMovesStateUp(this, name);
  },
);

Then(
  "the states are offered in the order {string}, {string}, {string}",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    third: string,
  ): Promise<void> {
    expect(await statesOffered(this)).toEqual([first, second, third]);
  },
);

Then(
  "{string} is already at the top of the list",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // No arrow at all is how the site says "no further" — there is no request
    // that could wrap the state round to the bottom.
    expect(await stateIsOfferedAMoveUp(this, name)).toBe(false);
  },
);
