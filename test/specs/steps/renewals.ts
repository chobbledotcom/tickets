import { Given, Then } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { attendeeAccount } from "#accounting/accounts.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import { legsOfKind } from "#test/specs/support/money-reads.ts";
import {
  stripeRenews,
  subscriberOn,
} from "#test/specs/support/subscriptions.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

Given(
  "Stripe took a renewal of {word} on {word}",
  function (this: TicketsWorld, paid: string, day: string): void {
    stripeRenews(this, "active", minorUnits(paid), day);
  },
);

Given(
  "Stripe took a last renewal of {word} on {word}, then ended the subscription",
  function (this: TicketsWorld, paid: string, day: string): void {
    stripeRenews(this, "canceled", minorUnits(paid), day);
  },
);

Then(
  "the {word} booking paid {word} on {word}",
  async function (
    this: TicketsWorld,
    name: string,
    paid: string,
    day: string,
  ): Promise<void> {
    const legs = await transfersByAccount(
      attendeeAccount(await subscriberOn(this, name)),
    );
    const onTheDay = legsOfKind(legs, "payment")
      .filter((leg) => leg.occurredAt.startsWith(day))
      .map((leg) => leg.amount);
    expect(onTheDay).toEqual([minorUnits(paid)]);
  },
);
