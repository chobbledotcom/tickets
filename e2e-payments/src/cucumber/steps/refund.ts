/**
 * The owner refund steps: the stale two-window race, the scoped Money fault
 * and its recovery, and the shared single-refund conformance with its two
 * honest outcomes (recorded, or safely observing).
 */

import { Then, When } from "@cucumber/cucumber";
import { requirePageText } from "#e2e/browser.ts";
import { config } from "#e2e/config.ts";
// jscpd:ignore-start -- the #e2e alias import for LiveWorld is structural
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
// jscpd:ignore-end
import { refuseRefundTransfers } from "#e2e/db-fault.ts";
import { login } from "#e2e/flow.ts";
import {
  classifyReturnedLocalDue,
  classifySubmittedRefund,
} from "#e2e/refund-outcome.ts";
import {
  attendeeOverviewFacts,
  attendeeTabOf,
  gatherRefundPageFacts,
  moneyRefundCount as moneyRefundCountOf,
  observeRefund,
  openAttendeePageIn,
  openAttendeeTabIn,
  openRefundForm,
  ownerOf,
  requireExactly,
  requireMoneyRefunds,
  requireNoExactLink,
  submitRenderedRefundForm,
} from "./pages.ts";

/** Refund must be gone and the rendered Delete action must genuinely work. */
const requireDeleteReachable = async (world: LiveWorld): Promise<void> => {
  const owner = ownerOf(world);
  await openAttendeeTabIn(owner, "actions");
  await requireNoExactLink(
    owner,
    "Refund",
    "Refund action offered after the refund",
  );
  // Prove Delete reachability through the real control: clicking it must open
  // the enabled Delete Attendee confirmation form (which is then abandoned).
  await owner.clickLink("Delete");
  const confirm = owner.page.getByRole("button", {
    exact: true,
    name: "Delete Attendee",
  });
  if ((await confirm.count()) !== 1 || !(await confirm.first().isEnabled())) {
    throw new Error(
      "the Delete action does not open an enabled Delete Attendee confirmation",
    );
  }
};

/** The attendee Overview must report the refund status. */
const requireRefundStatus = async (world: LiveWorld): Promise<void> => {
  const { paymentDetails } = await attendeeOverviewFacts(world);
  if (
    !paymentDetails.includes("Refund Status:") ||
    !paymentDetails.includes("Refunded")
  ) {
    throw new Error(
      `the attendee payment details do not say Refunded:\n${paymentDetails.slice(
        0,
        400,
      )}`,
    );
  }
};

/** The owner's Refresh control from the attendee Overview, asserting the
 * answer the app gives back. */
const refreshPayment = async (
  world: LiveWorld,
  expectedAnswer: string | RegExp,
): Promise<void> => {
  const owner = ownerOf(world);
  await attendeeTabOf(world, "");
  await owner.clickButton("Refresh payment status");
  await requirePageText(
    owner,
    expectedAnswer,
    "payment-refresh-no-answer",
    "Expected the refreshed payment page to answer; got:",
  );
  world.recordPhase("payment-refreshed");
};

When(
  "the owner opens the same refund form in two windows",
  async function (this: LiveWorld): Promise<void> {
    await openRefundForm(this);
    // The stale-form race: a second, independently signed-in window renders
    // and holds its own refund form before the first one submits.
    const second = await this.secondOwnerWindow();
    await login(second, this.scenario.owner);
    await openAttendeePageIn(second, this);
    await openAttendeeTabIn(second, "actions");
    await second.clickLink("Refund");
    this.recordPhase("two-refund-windows-open");
  },
);

When(
  "Money temporarily refuses to record refund transfers",
  async function (this: LiveWorld): Promise<void> {
    this.installFault(await refuseRefundTransfers(this.resources.server));
    this.recordPhase("money-fault-installed");
  },
);

/** Submit the rendered refund form and note the phase in the journal. */
const submitRefundForm = async (
  world: LiveWorld,
  phase: string,
): Promise<void> => {
  await submitRenderedRefundForm(ownerOf(world), world.scenario.booker.name);
  world.recordPhase(phase);
};

When(
  "the owner submits the first refund form",
  async function (this: LiveWorld): Promise<void> {
    await submitRefundForm(this, "first-refund-submitted");
  },
);

Then(
  "the owner is warned not to refund again",
  async function (this: LiveWorld): Promise<void> {
    // The failed local recording redirected to Refund recovery with the warning.
    await requirePageText(
      this.resources.owner,
      "could not be recorded in Money",
      "refund-not-recorded-warning-missing",
      "Expected the Refund recovery warning that money was returned but not recorded; got:",
    );
  },
);

Then(
  "Refund and Delete are unavailable while Refresh remains reachable",
  async function (this: LiveWorld): Promise<void> {
    classifyReturnedLocalDue(await gatherRefundPageFacts(this));
  },
);

When(
  "the owner submits the stale second refund form",
  async function (this: LiveWorld): Promise<void> {
    const second = await this.secondOwnerWindow();
    await submitRenderedRefundForm(second, this.scenario.booker.name);
    const landing = await second.bodyText();
    if (landing.includes("Refund issued")) {
      throw new Error(
        "the stale second refund form was accepted as a fresh refund",
      );
    }
    this.recordPhase("stale-form-submitted");
  },
);

/** The Money-statement Thens: the step text and the refund count it demands. */
const MONEY_REFUND_STEPS: readonly [string, number, string][] = [
  ["Money still has no refund entry", 0, "Money refund entry"],
  ["Money shows exactly one refund", 1, "Money refund"],
];

for (const [text, expected, what] of MONEY_REFUND_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await requireMoneyRefunds(this, expected, what);
  });
}

When(
  "Money accepts refund transfers again",
  async function (this: LiveWorld): Promise<void> {
    const fault = this.installedFault;
    if (fault === null) {
      throw new Error("no Money fault is installed to remove");
    }
    await fault.remove();
    this.recordPhase("money-fault-removed");
  },
);

/** Every owner-refresh When and the SPECIFIC app answer it requires — the
 * rendered "Refresh payment status" button must never satisfy one of these.
 * The recovery refresh must actually record the already-returned refund.
 * The observation-only refresh has exactly two honest answers: nothing new,
 * or a provider-settled refund the refresh just recorded. The exact-payment
 * refresh runs before any refund, so only "up to date" is right. */
const REFRESH_STEPS: readonly [string, string | RegExp][] = [
  ["the owner refreshes the payment", "Payment status updated: refunded"],
  [
    "the owner refreshes the payment without submitting Refund again",
    /Payment status (is up to date|updated: refunded)/,
  ],
  ["the owner refreshes the exact payment", "Payment status is up to date"],
];

for (const [text, answer] of REFRESH_STEPS) {
  When(text, async function (this: LiveWorld) {
    await refreshPayment(this, answer);
  });
}

Then(
  "the booking says the payment was refunded",
  async function (this: LiveWorld): Promise<void> {
    await requireRefundStatus(this);
  },
);

Then(
  "Refund is unavailable while Delete is reachable",
  async function (this: LiveWorld): Promise<void> {
    await requireDeleteReachable(this);
  },
);

/** The shared single-refund journey (Square and SumUp scenarios). */

/** The one rendered Refund submission: open the form, submit it, and mark
 * that a refund may have landed from here on. */
const submitScenarioRefundForm = async (world: LiveWorld): Promise<void> => {
  await openRefundForm(world);
  await submitRefundForm(world, "refund-submitted");
  world.runJournal.refundMayHaveLanded = true;
};

When(
  "the owner submits its rendered refund form once",
  async function (this: LiveWorld): Promise<void> {
    await submitScenarioRefundForm(this);
  },
);

Then(
  "the refund is either recorded or visibly waiting for observation",
  async function (this: LiveWorld): Promise<void> {
    // The provider's returned amount must be exact whenever it is visible at
    // all — regardless of whether the local record has caught up yet.
    const observation = await observeRefund(this);
    if (
      observation.kind === "completed" &&
      observation.returnedAmount !== config.unitPrice
    ) {
      throw new Error(
        `the provider returned ${observation.returnedAmount} of the captured ` +
          `${config.unitPrice} — not the exact amount`,
      );
    }
    // The LOCAL page state classifies the outcome: the app honestly reports
    // what was recorded at submission time, and a provider that completes a
    // refund moments later only makes the observation Refresh-eligible.
    const outcome = classifySubmittedRefund(await gatherRefundPageFacts(this));
    this.recordRefundState({ outcome: outcome.kind, provider: this.target });
  },
);

/** The three "while observation is unfinished" Thens: what they check on the
 * attendee's tabs, keyed by step text. */
const OBSERVATION_TAB_STEPS: readonly [
  string,
  "" | "actions",
  (world: LiveWorld) => Promise<void>,
][] = [
  [
    "no second Refund action is available",
    "actions",
    async (world) =>
      await requireNoExactLink(
        ownerOf(world),
        "Refund",
        "second Refund action",
      ),
  ],
  [
    "Refresh is reachable while observation is unfinished",
    "",
    async (world) =>
      requireExactly(
        await ownerOf(world)
          .page.getByRole("button", {
            exact: true,
            name: "Refresh payment status",
          })
          .count(),
        1,
        "reachable Refresh payment status control",
      ),
  ],
];

for (const [text, tab, check] of OBSERVATION_TAB_STEPS) {
  Then(text, async function (this: LiveWorld) {
    await attendeeTabOf(this, tab);
    await check(this);
  });
}

Then(
  "destructive actions are unavailable while observation is unfinished",
  async function (this: LiveWorld): Promise<void> {
    await attendeeTabOf(this, "actions");
    if (this.refundResult?.outcome === "refund_recorded") {
      // Recorded: the send is gone (its own step proves that). Delete may or
      // may not be back yet — a provider-side-completed refund whose
      // retirement has not caught up safely blocks Delete for a while, which
      // the Stripe recovery scenario covers where retirement completed.
      return;
    }
    await requireNoExactLink(
      ownerOf(this),
      "Delete",
      "Delete action offered while the refund is still observed",
    );
  },
);

Then(
  "the provider's returned amount and Money refund count do not grow",
  async function (this: LiveWorld): Promise<void> {
    const after = await observeRefund(this);
    const moneyAfter = await moneyRefundCountOf(this);
    // A completed final observation must show EXACTLY the captured amount:
    // a partial return is as wrong as an excess one, so equality is
    // required here, not merely a no-growth ceiling.
    const inexactReturn =
      after.kind === "completed" && after.returnedAmount !== config.unitPrice;
    if (inexactReturn || moneyAfter > 1) {
      throw new Error(
        "the final observation is not one exact refund: " +
          `${JSON.stringify(after)} (captured ${config.unitPrice}), ` +
          `${moneyAfter} Money refund(s)`,
      );
    }
  },
);
