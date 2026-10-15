// jscpd:ignore-start

import { Given, Then } from "@cucumber/cucumber";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { refundProviderFor } from "#test/specs/steps/refund-safety/common.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { usableInputsOfKind } from "#test/specs/support/form-controls/reading.ts";
import {
  refundSafety,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  chargeMoney,
  gbp,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";
import { says } from "#test-utils/says.ts";

// jscpd:ignore-end

Given(
  "Stripe says a failed refund returned {float} to {word}",
  function (this: TicketsWorld, pounds: number, who: string): void {
    const booking = safetyBooking(this, who);
    const returned = Math.round(pounds * 100);
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(booking.amount);
    refundProviderFor(this).showCharge("stripe", booking.paymentReference, {
      ...chargeMoney(booking.amount, returned),
      refunds: [
        refundObservation({
          amount: gbp(returned),
          reason: "provider_failed",
          refund: {
            ...refundResource,
            id: `re_failed_${booking.sessionId}`,
            parentId: booking.paymentReference,
          },
          status: "failed",
        }),
      ],
    });
  },
);

/** The partial-return case: the only offered decision is that the returned
 * part came back — the page offers no resend and no provider check, because
 * the evidence is already final and checking again could not change it. */
Then(
  "the partial return asks for the owner's decision and never a resend",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    says(browser.pageText, "Owner decision needed");
    // The one radio is the returned-only decision; "not sent" would re-arm
    // a send that pays the returned part twice, and "check again" cannot
    // change final evidence.
    expect(usableInputsOfKind(browser.currentHtml, "radio")).toEqual([
      {
        field: "choice",
        tag: '<input name="choice" required type="radio" value="provider_confirmed_returned">',
      },
    ]);
    assert(
      !browser.currentHtml.includes('value="provider_confirmed_not_sent"'),
    );
    assert(!browser.currentHtml.includes('value="check_again"'));
  },
);

Then(
  "no provider was contacted again for {word}",
  function (this: TicketsWorld, who: string): void {
    const provider = refundProviderFor(this);
    const booking = safetyBooking(this, who);
    expect(provider.sends).toEqual([]);
    expect(provider.reads.length + provider.sends.length).toBe(
      refundSafety(this).ownerContactCount,
    );
    expect(provider.reads.at(-1)).toEqual({
      provider: "stripe",
      reference: booking.paymentReference,
    });
  },
);
