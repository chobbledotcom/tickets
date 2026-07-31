// jscpd:ignore-start -- imports
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import { getPaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { PAYMENT_ID } from "#test/shared/db/payments/fixtures.ts";
import {
  openOwnerPaymentCase,
  prepareRefundableOwnerPaymentCase,
} from "#test/specs/support/owner-payment-cases.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestManagerSession } from "#test-utils/session.ts";

// jscpd:ignore-end

Given(
  "a payment case requires the owner's decision",
  async function (this: TicketsWorld): Promise<void> {
    await prepareRefundableOwnerPaymentCase(this);
  },
);

When(
  "the owner submits the case without choosing a decision",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openOwnerPaymentCase(this);
    await browser.submitForm(
      { reason: "I checked the payment" },
      "Save and carry out decision",
    );
  },
);

Then(
  "the case asks the owner to choose a decision",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.paymentBrowser, "owner browser").pageText,
    ).toContain("Choose a decision to continue.");
  },
);

Given(
  "the owner opened a payment case before its facts changed",
  async function (this: TicketsWorld): Promise<void> {
    await prepareRefundableOwnerPaymentCase(this);
    const browser = await openOwnerPaymentCase(this);
    const context = await getPaymentOperatorCase(
      requiredWorldValue(this.paymentCaseId, "payment case id"),
    );
    if (context === null) throw new Error("Expected payment case context");
    await recordPaymentCase({
      evidence: context.case.evidence,
      nextReconcileAt: null,
      paymentId: context.case.paymentId,
      reason: context.case.reason,
      resource: context.case.resource,
      state: "needs_action",
    });
    this.paymentBrowser = browser;
    const provider = stub(stripePaymentProvider, "refundCharge", () => {
      throw new Error("A stale owner decision called the provider");
    });
    this.cleanup.add(() => provider.restore());
    this.paymentProviderCalls = () => provider.calls.length;
  },
);

When(
  "the owner submits the older decision",
  async function (this: TicketsWorld): Promise<void> {
    await requiredWorldValue(this.paymentBrowser, "owner browser").submitForm(
      {
        decision: "refund_remaining",
        reason: "I checked the older payment facts",
      },
      "Save and carry out decision",
    );
  },
);

Then(
  "no payment action is carried out",
  async function (this: TicketsWorld): Promise<void> {
    expect(
      requiredWorldValue(this.paymentProviderCalls, "provider calls")(),
    ).toBe(0);
    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      { refunded: { amount: 0 } },
      { refunded: { amount: 0 } },
    ]);
    expect(
      await getPaymentCaseDecisions(
        requiredWorldValue(this.paymentCaseId, "payment case id"),
      ),
    ).toEqual([]);
  },
);

Then(
  "the owner is asked to review the latest facts",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.paymentBrowser, "owner browser").pageText,
    ).toContain("Review the latest facts and choose again.");
  },
);

Given(
  "a manager is signed in while a payment case is waiting",
  async function (this: TicketsWorld): Promise<void> {
    await prepareRefundableOwnerPaymentCase(this);
  },
);

When(
  "the manager checks the admin area and payment cases",
  async function (this: TicketsWorld): Promise<void> {
    const cookie = await createTestManagerSession(
      "spec-payment-manager",
      "specpaymentmanager",
    );
    const home = await awaitTestRequest("/admin/", { cookie });
    const list = await awaitTestRequest("/admin/payments", { cookie });
    this.paymentManagerHome = await home.text();
    this.paymentManagerListStatus = list.status;
  },
);

Then(
  "no payment case link or page is visible",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.paymentManagerHome, "manager page"),
    ).not.toContain("/admin/payments");
    expect(
      requiredWorldValue(this.paymentManagerListStatus, "manager status"),
    ).toBe(403);
  },
);
