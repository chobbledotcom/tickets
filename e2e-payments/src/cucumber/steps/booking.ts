/**
 * The payment and booking-confirmation steps: the visitor pays on each
 * provider's real sandbox, the exact return/callback is replayed, and the
 * owner-visible booking is asserted against the exact provider resource.
 */

import { Then, When } from "@cucumber/cucumber";
import {
  type BrowserSession,
  holdFirstAppReturn,
  requirePageText,
} from "#e2e/browser.ts";
import { config } from "#e2e/config.ts";
// jscpd:ignore-start -- the #e2e alias import for LiveWorld is structural
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
// jscpd:ignore-end
import {
  assertBookedInAdmin,
  countOnRoster,
  requireNoRecognisedIncome,
  waitForHostedCheckout,
} from "#e2e/flow.ts";
import { bookComplexOrder, verifyComplexOrder } from "#e2e/order-flow.ts";
import {
  deliverGenuineCallbackTwice,
  deliverRefusalProbes,
  FIXED_REFUSAL,
} from "#e2e/providers/sumup-callback.ts";
import type { PaidSandboxCheckout } from "#e2e/providers/types.ts";
import {
  attendeeTabOf,
  bookAsVisitor,
  bookingIdentity,
  openScenarioListing,
  ownerOf,
  requireExactly,
  requireFullAmountReturned,
  requireMoneyRefunds,
  requireOnScenarioRoster,
  requireSingleBooking,
} from "./pages.ts";

/** Where the app accepts its payment callbacks, for this scenario. */
const callbackTargetOf = (world: LiveWorld) => ({
  baseUrl: world.resources.tunnel.publicBaseUrl,
  serverLogPath: world.resources.server.logPath,
});

/** The shared checkout-context every provider driver needs: the callback
 * target plus this scenario's provider secrets. */
const hostedContext = (world: LiveWorld) => ({
  ...callbackTargetOf(world),
  secrets: world.paidProvider.secrets,
});

/** Submit the booking and let the provider's hosted page take over. */
const sendVisitorToCheckout = async (world: LiveWorld): Promise<void> => {
  await bookAsVisitor(world);
  await waitForHostedCheckout(world.resources.visitor);
};

/** Pay on the provider's hosted page and remember the exact checkout. */
const payHosted = async (world: LiveWorld): Promise<void> => {
  const checkout: PaidSandboxCheckout =
    await world.paidProvider.provider.payHostedCheckout(
      world.resources.visitor.page,
      hostedContext(world),
    );
  world.rememberCheckout(checkout);
  world.recordPhase("checkout-paid");
};

/** Pay through Stripe while holding the first browser return, so only the
 * signed webhook can create the booking; the exact intercepted URL is kept
 * for the replay step. */
const payStripeWithHeldReturn = async (world: LiveWorld): Promise<void> => {
  const held = holdFirstAppReturn(world.resources.visitor);
  await payHosted(world);
  world.rememberHeldReturn(await held.capturedUrl());
};

/** The return-confirmed providers share one step body: submit the booking,
 * then settle it on the provider's own page. */
const payOnHostedPage = async (world: LiveWorld): Promise<void> => {
  await sendVisitorToCheckout(world);
  await payHosted(world);
};

/** Every hosted-payment step: the text it is known by, and how it pays. */
const HOSTED_PAYMENT_STEPS: [string, (world: LiveWorld) => Promise<void>][] = [
  [
    "a separate visitor pays through Stripe Checkout",
    async (world) => {
      await sendVisitorToCheckout(world);
      await payStripeWithHeldReturn(world);
    },
  ],
  [
    "the Square sandbox completes a separate visitor's payment",
    payOnHostedPage,
  ],
  ["a separate visitor pays through SumUp's hosted checkout", payOnHostedPage],
  ["the visitor completes Stripe Checkout", payStripeWithHeldReturn],
];

for (const [text, pay] of HOSTED_PAYMENT_STEPS) {
  When(
    text,
    { timeout: config.hostedPaymentStepTimeoutMs },
    async function (this: LiveWorld) {
      await pay(this);
    },
  );
}

/**
 * Steps that wait for exactly one booking on the roster: the step text, the
 * failure wording, and the follow-up check after the booking is confirmed.
 */
const SINGLE_BOOKING_STEPS: readonly [
  string,
  string,
  (world: LiveWorld) => Promise<void>,
][] = [
  [
    "Stripe's signed webhook confirms the payment",
    "booking created by the signed webhook",
    async (world) => world.recordPhase("webhook-booked"),
  ],
  [
    "there is still one retained booking and one refund",
    "retained booking after the replay",
    async (world) => await requireMoneyRefunds(world, 1, "Money refund"),
  ],
];

for (const [text, what, after] of SINGLE_BOOKING_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await requireSingleBooking(this, what);
    await after(this);
  });
}

/** Steps that assert a specific fact appears on the scenario's roster: the
 * step text, what to look for, the failure wording, and the journal phase. */
const ROSTER_CHECK_STEPS: readonly [
  string,
  (world: LiveWorld) => string,
  string,
  string,
][] = [
  [
    "Stripe's signed webhook processes the payment",
    (world) => world.scenario.booker.email,
    "the signed webhook did not retain a booking for the paying visitor",
    "webhook-terminalized",
  ],
  [
    "the owner sees one retained No quantity booking",
    () => "No quantity",
    "the retained booking does not show the No quantity indicator",
    "retained-no-quantity-checked",
  ],
];

for (const [text, expectedOf, missing, phase] of ROSTER_CHECK_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await requireOnScenarioRoster(this, expectedOf(this), missing);
    this.recordPhase(phase);
  });
}

/** The visitor follows the exact held return URL — the replay under test. */
const visitorFollowsHeldReturn = async (world: LiveWorld): Promise<void> => {
  await world.resources.visitor.goto(world.heldReturn);
  world.recordPhase("return-replayed");
};

When(
  "the visitor retries the exact browser return",
  async function (this: LiveWorld): Promise<void> {
    await visitorFollowsHeldReturn(this);
  },
);

When(
  "the visitor retries the exact payment return",
  async function (this: LiveWorld): Promise<void> {
    await this.resources.visitor.goto(this.paidCheckout.returnUrl);
    this.recordPhase("return-replayed");
  },
);

Then(
  "the owner sees one attendee and the captured income once",
  async function (this: LiveWorld): Promise<void> {
    const attendees = await assertBookedInAdmin(
      this.resources.owner,
      bookingIdentity(this),
      this.scenario.owner,
    );
    requireExactly(
      countOnRoster(attendees, this.scenario.booker.email),
      1,
      `booking for ${this.scenario.booker.email} after the replay`,
    );
  },
);

When(
  "the genuine checkout callback is delivered twice",
  async function (this: LiveWorld): Promise<void> {
    await deliverGenuineCallbackTwice(callbackTargetOf(this));
    this.recordPhase("callback-delivered-twice");
  },
);

When(
  "forged, oversized, empty and missing callback ids are delivered",
  async function (this: LiveWorld): Promise<void> {
    this.rememberRefusalProbes(
      await deliverRefusalProbes(callbackTargetOf(this)),
    );
  },
);

Then(
  "each receives the same fixed retryable refusal",
  function (this: LiveWorld): void {
    const { answers } = this.refusalProbes;
    const same =
      answers.length === 4 &&
      answers.every(
        (answer) =>
          answer.status === FIXED_REFUSAL.status &&
          answer.contentType === FIXED_REFUSAL.contentType &&
          answer.body === FIXED_REFUSAL.body,
      );
    if (!same) {
      throw new Error(
        `the four probes did not all receive the one fixed refusal: ${JSON.stringify(
          answers,
        )}`,
      );
    }
  },
);

Then(
  "the refused callbacks cause no additional SumUp read",
  function (this: LiveWorld): void {
    const { newReads, newRefusals } = this.refusalProbes;
    if (newReads !== 0 || newRefusals !== 4) {
      throw new Error(
        "expected 4 new refusal log lines and 0 new SumUp reads, got " +
          `${newRefusals} and ${newReads}`,
      );
    }
  },
);

/** The owner edits the listing's price while the visitor is mid-checkout. */
const changeListingPrice = async (world: LiveWorld): Promise<void> => {
  await openScenarioListing(world, "overview");
  await ownerOf(world).clickLink("Edit");
  await ownerOf(world).fill(
    "unit_price",
    ((config.unitPrice + 100) / 100).toFixed(2),
  );
  await ownerOf(world).clickButton("Save changes");
  world.recordPhase("listing-price-changed");
};

When(
  "the owner changes the listing price in another browser",
  async function (this: LiveWorld): Promise<void> {
    await changeListingPrice(this);
  },
);

/** The stored terminal outcome is shown on the exact return URL — the visitor
 * was parked on the held page while the webhook processed. */
const visitorSeesRefundNotice = async (world: LiveWorld): Promise<void> => {
  await visitorFollowsHeldReturn(world);
  await requirePageText(
    world.resources.visitor,
    "automatically refunded",
    "invalidated-visitor-not-told",
    "Expected the visitor to be told their details were saved and the payment refunded; got:",
  );
};

Then(
  "the visitor is told their details were saved and payment refunded",
  async function (this: LiveWorld): Promise<void> {
    await visitorSeesRefundNotice(this);
  },
);

/** Every "the provider shows the money back" Then: the step text, and the
 * context its failure message names. The "still shows only" text serves both
 * the fault scenario and the invalidation replay. */
const AMOUNT_RETURNED_STEPS: [string, string][] = [
  ["Stripe shows the exact captured amount returned", "Stripe"],
  ["Stripe shows the full amount returned", "Stripe"],
  ["Stripe still shows only the original returned amount", "Stripe"],
];

for (const [text, context] of AMOUNT_RETURNED_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await requireFullAmountReturned(this, context);
  });
}

Then(
  "Money shows the payment and one refund netting to zero",
  async function (this: LiveWorld): Promise<void> {
    const ledger = await attendeeTabOf(this, "ledger");
    requireExactly(
      ledger.split("Payment received for").length - 1,
      1,
      "payment row",
    );
    requireExactly(ledger.split("Refund paid to").length - 1, 1, "refund row");
    const balance = await finalBalanceFigure(ownerOf(this));
    if (!/^[^0-9]*0(?:\.00)?$/.test(balance.trim())) {
      throw new Error(
        `the payment and refund do not net to zero; final balance "${balance.trim()}"`,
      );
    }
  },
);

/** The unfulfilled booking's Money statement: the refund round-trip is there
 * but no sale was ever recorded for a booking that cannot be honoured. */
const requireNoSaleForUnfulfilled = async (world: LiveWorld): Promise<void> => {
  const ledger = await attendeeTabOf(world, "ledger");
  if (ledger.includes("Booking made")) {
    throw new Error("the unfulfilled booking recorded a sale");
  }
  await requireMoneyRefunds(world, 1, "Money refund");
};

Then(
  "Money shows no sale for the unfulfilled booking",
  async function (this: LiveWorld): Promise<void> {
    await requireNoSaleForUnfulfilled(this);
  },
);

Then(
  "the retained booking shows the system reason",
  async function (this: LiveWorld): Promise<void> {
    const body = await attendeeTabOf(this, "");
    if (
      !body.includes("kept at quantity 0") ||
      !body.includes("the listing price changed while they were paying") ||
      !body.includes("Refund code: price_changed")
    ) {
      throw new Error(
        "the retained booking does not carry the price-change system note",
      );
    }
  },
);

When(
  "a separate visitor submits them together using {word}",
  async function (this: LiveWorld, provider: string): Promise<void> {
    const paid = provider.toLowerCase() !== "free";
    if (paid && this.target !== provider.toLowerCase()) {
      throw new Error(
        `this scenario pays with ${provider} but the harness is running the ${this.target} target`,
      );
    }
    await bookComplexOrder(this.resources.visitor, this.orderIdentity, {
      paid,
      ...(paid
        ? {
            payHostedCheckout: () => payHosted(this),
          }
        : {}),
    });
    this.recordPhase("complex-order-booked");
  },
);

Then(
  "every requested booking path appears once",
  async function (this: LiveWorld): Promise<void> {
    await verifyComplexOrder(
      this.resources.owner,
      this.orderIdentity,
      this.builtOrderCatalog,
      { expectIncome: false },
    );
  },
);

Then(
  "each listing shows its exact expected income",
  async function (this: LiveWorld): Promise<void> {
    const owner = ownerOf(this);
    if (this.target === "free") {
      // A free order's exact expected income is zero — checked on every
      // listing, not skipped.
      for (const listingId of [
        this.builtOrderCatalog.memberAId,
        this.builtOrderCatalog.plainId,
      ]) {
        await owner.goto(`/admin/listing/${listingId}`);
        await requireNoRecognisedIncome(owner);
      }
      return;
    }
    await verifyComplexOrder(
      owner,
      this.orderIdentity,
      this.builtOrderCatalog,
      {
        expectIncome: true,
      },
    );
  },
);

/** The final balance figure of the attendee statement table. */
const finalBalanceFigure = async (session: BrowserSession): Promise<string> => {
  const cell = session.page.locator("table tr:has(td) td:last-child").last();
  return await cell.innerText();
};
