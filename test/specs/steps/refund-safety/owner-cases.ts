// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import type { ProviderRefundTarget } from "#shared/provider-refunds.ts";
import {
  type ProviderRefundDependencies,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { refundProviderFor } from "#test/specs/steps/refund-safety/common.ts";
import { adminBrowser, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  attribute,
  hasFlag,
  usableInputsOfKind,
} from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  type RefundSafetyState,
  refundSafety,
} from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";

// jscpd:ignore-end

const REFERENCE = "sumup-owner-recovery-reference";
const OBSERVATION_DELAY = 5 * 60 * 1000;

type OwnerCase = NonNullable<RefundSafetyState["ownerCase"]>;

const target = () =>
  ({
    evidence: { kind: "read_provider" },
    mode: "send",
    reference: { kind: "tagged", provider: "sumup", reference: REFERENCE },
  }) satisfies ProviderRefundTarget;

const dependencies = (at: number): ProviderRefundDependencies => ({
  loadProvider: (provider) => {
    if (provider !== "sumup") {
      throw new Error("The owner-recovery story asked for the wrong provider");
    }
    return Promise.resolve(sumupPaymentProvider);
  },
  now: () => at,
});

const ownerCase = (world: TicketsWorld): OwnerCase => {
  const found = refundSafety(world).ownerCase;
  if (found === undefined) {
    throw new Error("The story has no owner refund case");
  }
  return found;
};

const expectedProviderReference = (world: TicketsWorld): string => {
  const prepared = refundSafety(world).ownerCase;
  if (prepared !== undefined) return prepared.reference;
  const who = world.attendeeName;
  if (who === undefined) {
    throw new Error("The story has no attendee or prepared refund case");
  }
  const booking = refundSafety(world).bookings.get(who);
  if (booking === undefined) {
    throw new Error(`The story has no paid booking for ${who}`);
  }
  return booking.paymentReference;
};

const rememberReadyOwnerCase = async (
  world: TicketsWorld,
  startedAt: number,
): Promise<void> => {
  const stored = await loadRefundAuthorityByReference(
    await paymentReferenceIndex(target().reference),
  );
  if (stored === null || stored.state.kind !== "ready") {
    throw new Error("The callback did not leave a ready refund intent");
  }
  refundSafety(world).ownerCase = {
    id: stored.id,
    reference: REFERENCE,
    systemTime: startedAt,
  };
};

const showUnavailableSumUpCharge = (world: TicketsWorld) => {
  const provider = refundProviderFor(world);
  const charge = chargeMoney(4_500);
  provider.show("sumup", REFERENCE, {
    reason: "timeout",
    status: "unavailable",
  });
  return { charge, provider };
};

Given(
  "a SumUp refund intent is ready but has not been sent",
  async function (this: TicketsWorld): Promise<void> {
    const { charge, provider } = showUnavailableSumUpCharge(this);
    provider.answer("sumup", REFERENCE, {
      amount: charge.captured,
      kind: "completed",
      proof: { charge, kind: "charge_observation" },
    });
    const startedAt = Date.now();
    const result = await requestProviderRefund(
      {
        ...target(),
        callbackSessionId: "sumup-owner-recovery-callback",
        evidence: { captured: charge.captured, kind: "validated_callback" },
      },
      dependencies(startedAt),
    );
    expect(result.kind).toBe("withheld");
    provider.showCharge("sumup", REFERENCE, charge);
    await rememberReadyOwnerCase(this, startedAt);
    expect(provider.sendCount("sumup", REFERENCE)).toBe(0);
  },
);

Given(
  "a SumUp refund intent stayed unreadable until owner attention was due",
  async function (this: TicketsWorld): Promise<void> {
    const { charge } = showUnavailableSumUpCharge(this);
    const startedAt = Date.now() - OBSERVATION_DELAY;
    const result = await requestProviderRefund(
      {
        ...target(),
        callbackSessionId: "sumup-unreadable-owner-callback",
        evidence: { captured: charge.captured, kind: "validated_callback" },
      },
      dependencies(startedAt),
    );
    expect(result.kind).toBe("withheld");
    await rememberReadyOwnerCase(this, startedAt);
  },
);

Given(
  "a SumUp refund lost its answer and now needs the owner",
  async function (this: TicketsWorld): Promise<void> {
    const provider = refundProviderFor(this);
    const charge = chargeMoney(4_500);
    provider.showCharge("sumup", REFERENCE, charge);
    provider.answer("sumup", REFERENCE, {
      kind: "uncertain",
      reason: "network_error",
    });
    const startedAt = Date.now();
    const first = await requestProviderRefund(
      target(),
      dependencies(startedAt),
    );
    expect(first).toMatchObject({
      kind: "pending",
      state: "observing",
    });
    const ownerAt = startedAt + OBSERVATION_DELAY;
    const waiting = await requestProviderRefund(
      target(),
      dependencies(ownerAt),
    );
    expect(waiting).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
    if (waiting.kind !== "needs_owner_choice") {
      throw new Error("The lost SumUp answer did not create owner work");
    }
    refundSafety(this).ownerCase = {
      id: waiting.authority.id,
      reference: REFERENCE,
      systemTime: ownerAt,
    };
    expect(provider.sendCount("sumup", REFERENCE)).toBe(1);
  },
);

When(
  "the owner opens Privacy",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await browser.clickLink("Settings");
    await browser.clickLink("Privacy");
  },
);

Then(
  "the refund is listed without exposing its provider reference",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain(`Open refund ${ownerCase(this).id}`);
    expect(browser.pageText).not.toContain(ownerCase(this).reference);
  },
);

When(
  "the owner opens the listed refund",
  function (this: TicketsWorld): Promise<void> {
    return scenarioBrowser(this).clickLink(`Open refund ${ownerCase(this).id}`);
  },
);

Then(
  "the provider reference is shown with two required unanswered choices",
  function (this: TicketsWorld): void {
    expectRequiredUnansweredChoices(this, [
      "provider_confirmed_returned",
      "provider_confirmed_not_sent",
    ]);
  },
);

const expectRequiredUnansweredChoices = (
  world: TicketsWorld,
  expected: readonly string[],
): void => {
  const browser = scenarioBrowser(world);
  expect(browser.pageText).toContain(expectedProviderReference(world));
  const choices = usableInputsOfKind(browser.currentHtml, "radio").filter(
    ({ field }) => field === "choice",
  );
  expect(choices.map(({ tag }) => attribute(tag, "value"))).toEqual(expected);
  expect(choices.every(({ tag }) => hasFlag(tag, "required"))).toBe(true);
  expect(choices.every(({ tag }) => !hasFlag(tag, "checked"))).toBe(true);
};

Then(
  "the ready refund has one clearly marked Send control",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain("Send this refund");
    expect(browser.pageText).not.toContain("Check the provider again");
    expect(browser.currentHtml).toContain(
      'name="choice" type="hidden" value="check_again"',
    );
    expect(browser.currentHtml).toContain(
      '<button class="danger" type="submit">Send this refund</button>',
    );
    expect(usableInputsOfKind(browser.currentHtml, "radio")).toEqual([]);
  },
);

When(
  "the owner sends the ready refund",
  function (this: TicketsWorld): Promise<void> {
    return fillInAndSend(scenarioBrowser(this), {}, "Send this refund");
  },
);

Then(
  "SumUp receives exactly one refund attempt",
  function (this: TicketsWorld): void {
    expect(refundProviderFor(this).sendCount("sumup", REFERENCE)).toBe(1);
  },
);

Then("SumUp receives no refund attempt", function (this: TicketsWorld): void {
  expect(refundProviderFor(this).sendCount("sumup", REFERENCE)).toBe(0);
});

Then(
  "the owner is told that unreadable evidence sent no refund",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).pageText).toContain(
      "No refund was sent; check the payment there and make the required choice.",
    );
  },
);

Then(
  "the current page asks for the returned money to be recorded in Money",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).pageText).toContain(
      "I confirm that this returned money is now recorded in Money.",
    );
  },
);

const ownerChooses = (
  world: TicketsWorld,
  choice: "provider_confirmed_not_sent" | "provider_confirmed_returned",
): Promise<void> =>
  fillInAndSend(
    scenarioBrowser(world),
    { choice },
    "Use this provider decision",
  );

When(
  "the owner chooses that no refund was sent",
  function (this: TicketsWorld): Promise<void> {
    return ownerChooses(this, "provider_confirmed_not_sent");
  },
);

When(
  "the owner chooses that the money was returned",
  function (this: TicketsWorld): Promise<void> {
    return ownerChooses(this, "provider_confirmed_returned");
  },
);

Then(
  "saving the choice sends no second refund",
  function (this: TicketsWorld): void {
    expect(refundProviderFor(this).sendCount("sumup", REFERENCE)).toBe(1);
  },
);

Then(
  "the resolved case leaves the owner queue",
  function (this: TicketsWorld): void {
    expect(scenarioBrowser(this).pageText).not.toContain(
      `Open refund ${ownerCase(this).id}`,
    );
  },
);

Then(
  "the newly authorised attempt remains reachable in the owner queue",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain(`Open refund ${ownerCase(this).id}`);
    expect(browser.pageText).toContain("Refund ready to continue");
  },
);

When(
  "the refund process continues from that authority",
  async function (this: TicketsWorld): Promise<void> {
    const state = ownerCase(this);
    const charge = chargeMoney(4_500);
    refundProviderFor(this).answer("sumup", REFERENCE, {
      amount: charge.captured,
      kind: "completed",
      proof: { charge, kind: "charge_observation" },
    });
    const result = await requestProviderRefund(
      target(),
      dependencies(state.systemTime + 1),
    );
    expect(result.kind).toBe("returned");
  },
);

Then(
  "SumUp receives one newly authorised refund attempt",
  function (this: TicketsWorld): void {
    expect(refundProviderFor(this).sendCount("sumup", REFERENCE)).toBe(2);
  },
);

Then(
  "the returned money still asks to be recorded in Money",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.clickLink(`Open refund ${ownerCase(this).id}`);
    expect(browser.pageText).toContain(
      "I confirm that this returned money is now recorded in Money.",
    );
  },
);

When(
  "the owner confirms that the returned money is recorded in Money",
  function (this: TicketsWorld): Promise<void> {
    return fillInAndSend(
      scenarioBrowser(this),
      { choice: "money_recorded" },
      "Confirm Money is recorded",
    );
  },
);

Then(
  "SumUp still received only its original refund attempt",
  function (this: TicketsWorld): void {
    expect(refundProviderFor(this).sendCount("sumup", REFERENCE)).toBe(1);
  },
);
