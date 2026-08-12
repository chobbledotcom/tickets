// jscpd:ignore-start
import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { getRefundPaymentReferencesForAttendee } from "#shared/db/payment-references.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  openActionsAsOwner,
  ownerRefunds,
} from "#test/specs/support/refund-safety/journeys.ts";
import {
  installRefundProviderScript,
  type RefundProviderScript,
} from "#test/specs/support/refund-safety/provider-script.ts";
import {
  refundSafety,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
// jscpd:ignore-end

/** The provider boundary shared by one safety scenario. */
export const refundProviderFor = (
  world: TicketsWorld,
): RefundProviderScript => {
  const state = refundSafety(world);
  if (state.provider === undefined) {
    state.provider = installRefundProviderScript(world.cleanup);
  }
  return state.provider;
};

/** The charge as the provider reports it before any refund. */
export const untouchedChargeFor = (
  world: TicketsWorld,
  who: string,
): ChargeMoney => chargeMoney(safetyBooking(world, who).amount);

/** The charge after every penny has reached the buyer. */
export const returnedChargeFor = (
  world: TicketsWorld,
  who: string,
): ChargeMoney => {
  const { amount } = safetyBooking(world, who);
  return chargeMoney(amount, amount);
};

/** A completed provider answer carrying the authoritative charge reading. */
export const completedRefundFor = (
  world: TicketsWorld,
  who: string,
): RefundAttemptResult => {
  const charge = returnedChargeFor(world, who);
  return {
    amount: charge.captured,
    kind: "completed",
    proof: { charge, kind: "charge_observation" },
  };
};

/** Reads one booking's payment references through the production reader. */
export const paymentReferencesFor = async (
  world: TicketsWorld,
  who: string,
): Promise<
  Awaited<ReturnType<typeof getRefundPaymentReferencesForAttendee>>
> => {
  const { attendeeId } = safetyBooking(world, who);
  const attendee = await getAttendeeOrNull(
    attendeeId,
    await getTestPrivateKey(),
  );
  if (attendee === null) throw new Error(`There is no booking for ${who}`);
  return await getRefundPaymentReferencesForAttendee(
    attendee,
    await getTestPrivateKey(),
  );
};

/** The exact money legs on one buyer's account. */
const moneyFor = (world: TicketsWorld, who: string) =>
  transfersByAccount(attendeeAccount(safetyBooking(world, who).attendeeId));

const legsNamed = async (world: TicketsWorld, who: string, kind: string) =>
  (await moneyFor(world, who)).filter((leg) => leg.kind === kind);

/** A full paid booking still has its one cash receipt and no cash refund. */
export const expectPaidWithoutRefund = async (
  world: TicketsWorld,
  who: string,
  pounds: string,
): Promise<void> => {
  const amount = Math.round(Number(pounds) * 100);
  const payments = await legsNamed(world, who, "payment");
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({
    amount,
    destination: attendeeAccount(safetyBooking(world, who).attendeeId),
    source: WORLD,
  });
  expect(await legsNamed(world, who, "refund_cash")).toEqual([]);
};

/** A complete refund has one exact cash leg back to the outside world. */
export const expectOneRecordedRefund = async (
  world: TicketsWorld,
  who: string,
): Promise<void> => {
  const { amount, attendeeId } = safetyBooking(world, who);
  const refunds = await legsNamed(world, who, "refund_cash");
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({
    amount,
    destination: WORLD,
    source: attendeeAccount(attendeeId),
  });
};

/** The organiser's page left by the most recent form submission. */
export const expectOwnerWasTold = (
  world: TicketsWorld,
  ...words: string[]
): void => {
  for (const word of words) {
    expect(scenarioBrowser(world).pageText).toContain(word);
  }
};

/** Reach payment refresh from Actions through the real Overview tab. */
export const refreshFromAttendeePage = async (
  world: TicketsWorld,
  who: string,
): Promise<void> => {
  const browser = await openActionsAsOwner(world, who);
  await browser.clickLink("Overview");
  await browser.submitForm({}, "Refresh payment status");
};

When(
  "the owner signs in and refunds {word} from her Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await ownerRefunds(this, who);
  },
);

Then(
  "Money does not yet show a refund for {word}",
  async function (this: TicketsWorld, who: string): Promise<void> {
    expect(await legsNamed(this, who, "refund_cash")).toEqual([]);
  },
);

Then(
  "Money shows one refund for {word}",
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectOneRecordedRefund(this, who);
  },
);

Then(
  "{word} is handed back {float} once",
  async function (
    this: TicketsWorld,
    who: string,
    pounds: number,
  ): Promise<void> {
    expect(safetyBooking(this, who).amount).toBe(Math.round(pounds * 100));
    expect(refundProviderFor(this).sendCount()).toBe(1);
    await expectOneRecordedRefund(this, who);
  },
);

Then(
  "{word}'s Actions page does not offer Refund",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = await openActionsAsOwner(this, who);
    expect(browser.findLink("Refund")).toBeNull();
  },
);

Then(
  "{word}'s attendee page offers Refresh payment status",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = await openActionsAsOwner(this, who);
    await browser.clickLink("Overview");
    expect(browser.formBodyFor("Refresh payment status")).not.toBe("");
  },
);

When(
  "the owner presses Refresh payment status from {word}'s attendee page",
  function (this: TicketsWorld, who: string): Promise<void> {
    return refreshFromAttendeePage(this, who);
  },
);

Then(
  "the owner is warned not to send the refund again",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(this, "Do not send the refund again");
  },
);

/** Count sends without folding provider reads into the answer. */
export const expectProviderSendCount = (
  world: TicketsWorld,
  provider: PaymentProviderType,
  who: string,
  count: number,
): void => {
  expect(
    refundProviderFor(world).sendCount(
      provider,
      safetyBooking(world, who).paymentReference,
    ),
  ).toBe(count);
};
