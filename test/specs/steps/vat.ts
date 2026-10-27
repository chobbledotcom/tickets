// jscpd:ignore-start

import { Then } from "@cucumber/cucumber";
import { expect } from "@std/expect";

// jscpd:ignore-end

import { attendeeAccount, TAX_VAT } from "#accounting/accounts.ts";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { bookingId } from "#test/specs/support/money.ts";
import { legsOfKind } from "#test/specs/support/money-reads.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

/** The tax account's balance alone could hide a tax leg that a refund later
 *  reversed, so the booking's own legs are checked for both tax kinds too. */
Then(
  "no value added tax was recorded or refunded",
  async function (this: TicketsWorld): Promise<void> {
    expect(await accountBalance(TAX_VAT)).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(legsOfKind(legs, "vat").length).toBe(0);
    expect(legsOfKind(legs, "refund_vat").length).toBe(0);
  },
);
