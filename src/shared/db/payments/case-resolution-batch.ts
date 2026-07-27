import { executeBatch } from "#shared/db/client.ts";
import { paymentCaseResolutionStatement } from "#shared/db/payments/cases.ts";
import type { PaymentCaseResource } from "#shared/db/payments/types.ts";

export type PaymentCaseResolution = {
  paymentId: string;
  resource: PaymentCaseResource;
};

/** Resolve exact payment-case resources in one database round trip. */
export const resolvePaymentCases = async (
  resolutions: readonly PaymentCaseResolution[],
  resolvedAt = Date.now(),
): Promise<void> => {
  if (resolutions.length === 0) return;
  await executeBatch(
    await Promise.all(
      resolutions.map(({ paymentId, resource }) =>
        paymentCaseResolutionStatement(paymentId, resource, resolvedAt),
      ),
    ),
  );
};
