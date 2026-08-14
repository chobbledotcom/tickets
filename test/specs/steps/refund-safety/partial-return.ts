// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { refundProviderFor } from "#test/specs/steps/refund-safety/common.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { usableInputsOfKind } from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
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

const expectOnlyProviderCheck = (world: TicketsWorld): void => {
  const browser = scenarioBrowser(world);
  expect(browser.pageText).toContain("Check the provider again");
  expect(browser.pageText).not.toContain("make the required choice");
  expect(browser.currentHtml).toContain(
    'name="choice" type="hidden" value="check_again"',
  );
  expect(browser.currentHtml).not.toContain("provider_confirmed_returned");
  expect(browser.currentHtml).not.toContain("provider_confirmed_not_sent");
  expect(usableInputsOfKind(browser.currentHtml, "radio")).toEqual([]);
};

Then(
  "the partial return can only be checked with the provider again",
  function (this: TicketsWorld): void {
    expectOnlyProviderCheck(this);
  },
);

When(
  "the owner checks the partial return with the provider",
  async function (this: TicketsWorld): Promise<void> {
    const provider = refundProviderFor(this);
    const contactsBefore = provider.reads.length + provider.sends.length;
    expect(contactsBefore).toBe(refundSafety(this).ownerContactCount);
    await fillInAndSend(
      scenarioBrowser(this),
      {},
      "Check the provider again",
    );
  },
);

Then(
  "Stripe was read once more and received no refund request for {word}",
  function (this: TicketsWorld, who: string): void {
    const provider = refundProviderFor(this);
    const booking = safetyBooking(this, who);
    expect(provider.sends).toEqual([]);
    expect(provider.reads.length + provider.sends.length).toBe(
      refundSafety(this).ownerContactCount + 1,
    );
    expect(provider.reads.at(-1)).toEqual({
      provider: "stripe",
      reference: booking.paymentReference,
    });
  },
);
