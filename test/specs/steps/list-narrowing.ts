// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { CUSTOMER, ORGANISER } from "#test/specs/support/browser.ts";
import {
  customerLooksAtEverything,
  expectNoChoiceOfKind,
  listOffers,
  organiserNarrowsList,
  organiserOpensList,
  whatTheCustomerSees,
} from "#test/specs/support/list-narrowing.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

When(
  "the organiser opens their list",
  function (this: TicketsWorld): Promise<void> {
    return organiserOpensList(this);
  },
);

When(
  "the organiser narrows the list to {string}",
  function (this: TicketsWorld, to: string): Promise<void> {
    return organiserNarrowsList(this, to);
  },
);

Then(
  "the list offers the {word}",
  function (this: TicketsWorld, name: string): void {
    expect(listOffers(this, name)).toBe(true);
  },
);

Then(
  "the list does not offer the {word}",
  function (this: TicketsWorld, name: string): void {
    expect(listOffers(this, name)).toBe(false);
  },
);

Then(
  "the organiser is offered no way to narrow the list by kind",
  function (this: TicketsWorld): void {
    expectNoChoiceOfKind(this, ORGANISER);
  },
);

When(
  "a customer looks at everything on sale",
  function (this: TicketsWorld): Promise<void> {
    return customerLooksAtEverything(this);
  },
);

Then(
  "the customer is shown both the {word} and the {word}",
  function (this: TicketsWorld, first: string, second: string): void {
    const shown = whatTheCustomerSees(this);
    expect(shown).toContain(first);
    expect(shown).toContain(second);
  },
);

Then(
  "the customer is offered no way to narrow the list by kind",
  function (this: TicketsWorld): void {
    expectNoChoiceOfKind(this, CUSTOMER);
  },
);
