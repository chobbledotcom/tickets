// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  completedRefundFor,
  expectPaidWithoutRefund,
  refundProviderFor,
} from "#test/specs/steps/refund-safety/common.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  buyPaidPlaceThroughPublicPage,
  openActionsAsOwner,
  openListedRefundCase,
  openOwnerAction,
  ownerRefunds,
} from "#test/specs/support/refund-safety/journeys.ts";
import {
  expectManagerActionsOpen,
  managerOpensSavedOwnerAddress,
  managerSubmitsSavedOwnerForm,
  saveOwnerMoneyForm,
} from "#test/specs/support/refund-safety/permissions.ts";
import {
  refundSafety,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import {
  managerAcceptsInviteAndLogsIn,
  managerBrowser,
  ownerInvitesManager,
} from "#test/specs/support/staff-accounts.ts";
import { organiserAddsState } from "#test/specs/support/statuses.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  chargeMoney,
  gbp,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

// jscpd:ignore-end

const providerContacts = (world: TicketsWorld): number => {
  const provider = refundProviderFor(world);
  return provider.reads.length + provider.sends.length;
};

const expectOnlyMoneyAction = async (
  world: TicketsWorld,
  who: string,
  action: "Mark payment reviewed" | "Open Refund recovery",
): Promise<void> => {
  const browser = await openActionsAsOwner(world, who);
  expect(browser.links.some(({ text }) => text.trim() === action)).toBe(true);
  expect(browser.links.some(({ text }) => text.trim() === "Refund")).toBe(
    false,
  );
};

const expectReviewAction = (world: TicketsWorld, who: string): Promise<void> =>
  expectOnlyMoneyAction(world, who, "Mark payment reviewed");

const expectProviderRecoveryAction = (
  world: TicketsWorld,
  who: string,
): Promise<void> => expectOnlyMoneyAction(world, who, "Open Refund recovery");

Given(
  "new bookings pay a {float} deposit",
  function (this: TicketsWorld, pounds: number): Promise<void> {
    return organiserAddsState(this, {
      deposit: pounds.toFixed(2),
      job: "where new bookings start",
      name: "Reserved",
    });
  },
);

Given(
  "{word} bought a {float} {word} place through the public booking page",
  async function (
    this: TicketsWorld,
    who: string,
    pounds: number,
    listing: string,
  ): Promise<void> {
    await buyPaidPlaceThroughPublicPage(this, who, pounds.toFixed(2), listing);
  },
);

Given(
  "the owner invited {word} as a manager",
  function (this: TicketsWorld, who: string): Promise<void> {
    return ownerInvitesManager(this, who);
  },
);

Given(
  "{word} accepted the invitation, chose a password and signed in",
  function (this: TicketsWorld, who: string): Promise<void> {
    return managerAcceptsInviteAndLogsIn(this, who);
  },
);

When(
  "{word} opens {word}'s Actions page",
  async function (
    this: TicketsWorld,
    manager: string,
    attendee: string,
  ): Promise<void> {
    const browser = managerBrowser(this, manager);
    await browser.visit(
      `/admin/attendees/${safetyBooking(this, attendee).attendeeId}/actions`,
    );
    expect(browser.pageText).toContain(attendee);
    this.attendeeName = attendee;
  },
);

Then(
  /^(\w+) is not offered (Refund|Mark payment reviewed|Open Refund recovery)$/,
  function (this: TicketsWorld, manager: string, action: string): void {
    expect(
      managerBrowser(this, manager).links.some(
        ({ text }) => text.trim() === action,
      ),
    ).toBe(false);
  },
);

Then(
  "every action {word} is offered opens for {word}",
  async function (
    this: TicketsWorld,
    manager: string,
    sameManager: string,
  ): Promise<void> {
    expect(sameManager).toBe(manager);
    const attendee = this.attendeeName;
    if (attendee === undefined) {
      throw new Error("No attendee Actions page opened");
    }
    await expectManagerActionsOpen(this, manager, attendee);
  },
);

Given(
  "Stripe says a failed refund returned 0.01 to {word}",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    refundProviderFor(this).showCharge("stripe", booking.paymentReference, {
      ...chargeMoney(booking.amount, 1),
      refunds: [
        refundObservation({
          amount: gbp(1),
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

Given(
  "Stripe is ready to return {word}'s payment",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    provider.showCharge(
      "stripe",
      booking.paymentReference,
      chargeMoney(booking.amount),
    );
    provider.answer(
      "stripe",
      booking.paymentReference,
      completedRefundFor(this, who),
    );
  },
);

Given(
  "the owner tried the refund and was offered Open Refund recovery",
  async function (this: TicketsWorld): Promise<void> {
    const who = safetyBooking(
      this,
      requiredWorldValue(this.attendeeName, "the attendee name"),
    ).who;
    await ownerRefunds(this, who);
    await expectProviderRecoveryAction(this, who);
    refundSafety(this).ownerContactCount = providerContacts(this);
  },
);

Given(
  "the owner returned the deposit and was offered Mark payment reviewed",
  async function (this: TicketsWorld): Promise<void> {
    const who = safetyBooking(
      this,
      requiredWorldValue(this.attendeeName, "the attendee name"),
    ).who;
    await ownerRefunds(this, who);
    await expectReviewAction(this, who);
    refundSafety(this).ownerContactCount = providerContacts(this);
  },
);

When(
  "the owner signs in and tries to refund {word} from her Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await ownerRefunds(this, who);
    refundSafety(this).ownerContactCount = providerContacts(this);
  },
);

When(
  "{word} opens the owner's saved refund confirmation address for {word}",
  async function (
    this: TicketsWorld,
    manager: string,
    who: string,
  ): Promise<void> {
    refundProviderFor(this);
    await saveOwnerMoneyForm(this, who, "refund");
    await managerOpensSavedOwnerAddress(this, manager, "refund");
  },
);

When(
  "{word} opens the owner's saved provider-recovery address for {word}",
  async function (
    this: TicketsWorld,
    manager: string,
    who: string,
  ): Promise<void> {
    await saveOwnerMoneyForm(this, who, "provider-recovery");
    await managerOpensSavedOwnerAddress(this, manager, "provider-recovery");
  },
);

When(
  "{word} submits the owner's saved provider-recovery form for {word}",
  function (this: TicketsWorld, manager: string, _who: string): Promise<void> {
    return managerSubmitsSavedOwnerForm(this, manager, "provider-recovery");
  },
);

When(
  "{word} submits the owner's saved refund form for {word}",
  function (this: TicketsWorld, manager: string, _who: string): Promise<void> {
    return managerSubmitsSavedOwnerForm(this, manager, "refund");
  },
);

When(
  "{word} opens the owner's saved payment-review address for {word}",
  async function (
    this: TicketsWorld,
    manager: string,
    who: string,
  ): Promise<void> {
    await saveOwnerMoneyForm(this, who, "review");
    await managerOpensSavedOwnerAddress(this, manager, "review");
  },
);

When(
  "{word} submits the owner's saved payment-review form for {word}",
  function (this: TicketsWorld, manager: string, _who: string): Promise<void> {
    return managerSubmitsSavedOwnerForm(this, manager, "review");
  },
);

Then(
  "{word} is refused access",
  function (this: TicketsWorld, _who: string): void {
    expect(refundSafety(this).managerAnswer).toBe(403);
  },
);

Then(
  "{word}'s Actions page still offers Open Refund recovery to the owner",
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectProviderRecoveryAction(this, who);
  },
);

Then(
  "{word}'s Actions page offers Open Refund recovery",
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectProviderRecoveryAction(this, who);
  },
);

Then(
  "no provider is asked to return {word}'s money",
  function (this: TicketsWorld, _who: string): void {
    expect(refundProviderFor(this).sends).toEqual([]);
  },
);

Then(
  "no provider is asked to return any more money",
  function (this: TicketsWorld): void {
    expect(refundProviderFor(this).sends).toEqual([]);
  },
);

Then(
  "Money still shows {word}'s {float} payment",
  function (this: TicketsWorld, who: string, pounds: number): Promise<void> {
    return expectPaidWithoutRefund(this, who, pounds.toFixed(2));
  },
);

Then(
  "{word}'s Actions page still offers Mark payment reviewed to the owner",
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectReviewAction(this, who);
  },
);

Then(
  /^(\w+)'s Actions page offers Mark payment reviewed(?: again)?$/,
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectReviewAction(this, who);
  },
);

When(
  "the owner opens Mark payment reviewed from {word}'s Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await openOwnerAction(this, who, "Mark payment reviewed");
    refundSafety(this).ownerContactCount = providerContacts(this);
  },
);

When(
  "the owner opens Open Refund recovery from {word}'s Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = await openOwnerAction(this, who, "Open Refund recovery");
    await openListedRefundCase(browser);
  },
);

When(
  "types {word}'s exact name and presses Mark payment reviewed",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = scenarioBrowser(this);
    await fillInAndSend(
      browser,
      { confirm_identifier: who },
      "Mark payment reviewed",
    );
  },
);

Then(
  "the owner is told the payment was marked reviewed",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.containsText("Payment review acknowledged")).toBe(true);
  },
);

Then(
  "the provider has not been contacted again",
  function (this: TicketsWorld): void {
    expect(providerContacts(this)).toBe(refundSafety(this).ownerContactCount);
  },
);

When(
  "the owner checks {word}'s Actions page again",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await openActionsAsOwner(this, who);
  },
);
