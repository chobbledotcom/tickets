// jscpd:ignore-start -- imports
import type { PaymentCase } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { createRefundablePaymentCase } from "#test/shared/payment-runtime/fixtures.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { loginTestAdminBrowser } from "#test-utils/admin-browser.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

export const saveOwnerPaymentCase = (
  world: TicketsWorld,
  paymentCase: Pick<PaymentCase, "id" | "revision">,
): void => {
  world.paymentCaseId = paymentCase.id;
  world.paymentCaseRevision = paymentCase.revision;
};

export const prepareRefundableOwnerPaymentCase = async (
  world: TicketsWorld,
  reason = "partial_refund",
): Promise<void> => {
  const target = await createRefundablePaymentCase(reason);
  world.cleanup.push(() => settings.clearTestOverrides());
  saveOwnerPaymentCase(world, target.paymentCase);
};

export const openOwnerPaymentCase = async (
  world: TicketsWorld,
): Promise<TestBrowser> => {
  const browser = await loginTestAdminBrowser();
  await browser.visit(
    `/admin/payments/${requiredWorldValue(world.paymentCaseId, "payment case id")}`,
  );
  world.paymentBrowser = browser;
  return browser;
};

export const chooseOwnerPaymentCaseDecision = async (
  world: TicketsWorld,
  decision: string,
): Promise<void> => {
  const browser = await openOwnerPaymentCase(world);
  const renderedDecision = decision.startsWith("assign_provider:")
    ? [...browser.currentHtml.matchAll(/<option[^>]+value="([^"]+)"/gu)]
        .map((match) => match[1]!)
        .find((value) => value.startsWith(`${decision}:`))
    : decision;
  if (renderedDecision === undefined) {
    throw new Error(`The payment form did not offer ${decision}`);
  }
  await browser.submitForm(
    { decision: renderedDecision, reason: "I checked the saved payment facts" },
    "Save and carry out decision",
  );
};
