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
import { readLoggedId } from "#e2e/providers/shared.ts";
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
 * The server-log evidence that the SIGNED webhook itself was verified and
 * processed. The roster alone cannot prove this — the visitor's browser
 * return can book first — but only the webhook route writes `[Webhook]
 * Payment callback …` lines, so one appearing is independent evidence the
 * webhook was delivered through the tunnel, its signature verified, and its
 * session resolved into the payment engine. The "is being processed
 * elsewhere" arm is accepted deliberately: the webhook can race the browser
 * return for the one reservation, and Stripe redelivers its 409 on a slow
 * schedule a nightly cannot wait out — the held line still proves delivery,
 * verification, and resolution.
 */
const WEBHOOK_EVIDENCE = {
  booked: {
    expected: "[Webhook] Payment callback booked",
    pattern:
      /\[Webhook\] Payment callback (booked|is being processed elsewhere)/g,
  },
  settled: {
    expected: "[Webhook] Payment callback settled without a booking",
    pattern:
      /\[Webhook\] Payment callback (settled without a booking|is being processed elsewhere)/g,
  },
} as const;

/** Build the follow-up check that waits for the signed webhook's own log
 * line — never inferred from pages — then records the step's phase. */
const webhookEvidenceThen =
  (evidence: keyof typeof WEBHOOK_EVIDENCE, phase: string) =>
  async (world: LiveWorld): Promise<void> => {
    const line = WEBHOOK_EVIDENCE[evidence];
    const outcome = await readLoggedId(
      world.resources.server.logPath,
      line.pattern,
      line.expected,
      config.paymentConfirmTimeoutMs,
    );
    world.recordPhase(`webhook-evidence-${outcome.replace(/[^a-z]+/g, "-")}`);
    world.recordPhase(phase);
  };

/** Steps that first prove a fact on the scenario's roster, then run a
 * follow-up check: the step text, the roster fact to prove, and the
 * follow-up once the fact holds. */
const ROSTER_FACT_STEPS: readonly [
  string,
  (world: LiveWorld) => Promise<void>,
  (world: LiveWorld) => Promise<void>,
][] = [
  [
    "Stripe's signed webhook confirms the payment",
    (world) =>
      requireSingleBooking(world, "booking created by the signed webhook"),
    webhookEvidenceThen("booked", "webhook-booked"),
  ],
  [
    "there is still one retained booking and one refund",
    (world) => requireSingleBooking(world, "retained booking after the replay"),
    (world) => requireMoneyRefunds(world, 1, "Money refund"),
  ],
  [
    "Stripe's signed webhook processes the payment",
    (world) =>
      requireOnScenarioRoster(
        world,
        world.scenario.booker.email,
        "the signed webhook did not retain a booking for the paying visitor",
      ),
    webhookEvidenceThen("settled", "webhook-terminalized"),
  ],
  [
    "the owner sees one retained No quantity booking",
    (world) =>
      requireOnScenarioRoster(
        world,
        "No quantity",
        "the retained booking does not show the No quantity indicator",
      ),
    async (world) => world.recordPhase("retained-no-quantity-checked"),
  ],
];

for (const [text, prove, after] of ROSTER_FACT_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await prove(this);
    await after(this);
  });
}

/** The visitor follows the exact held return URL — the replay under test. */
const visitorFollowsHeldReturn = async (world: LiveWorld): Promise<void> => {
  await world.resources.visitor.goto(world.heldReturn);
  world.recordPhase("return-replayed");
};

/** Every exact-return replay When: the step text and where the URL lives —
 * the Stripe held return (captured from the URL bar) or the checkout's own
 * recorded return binding. */
const RETURN_REPLAY_STEPS: readonly [string, (world: LiveWorld) => string][] = [
  ["the visitor retries the exact browser return", (w) => w.heldReturn],
  [
    "the visitor retries the exact payment return",
    (w) => w.paidCheckout.returnUrl,
  ],
  ["the visitor retries the exact return", (w) => w.paidCheckout.returnUrl],
];

for (const [text, urlOf] of RETURN_REPLAY_STEPS) {
  When(text, async function (this: LiveWorld) {
    await this.resources.visitor.goto(urlOf(this));
    this.recordPhase("return-replayed");
  });
}

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
  // The hosted-payment allowance: this step also settles the provider's
  // checkout page, which alone can take minutes over a fresh tunnel.
  { timeout: config.hostedPaymentStepTimeoutMs },
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
        this.builtOrderCatalog.memberBId,
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
