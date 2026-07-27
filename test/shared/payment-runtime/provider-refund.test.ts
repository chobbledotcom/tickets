import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  completedProviderRefund,
  failedProviderRefund,
  makeProviderRefund,
  makeProviderRefundRequest,
  partialProviderRefund,
  pendingProviderRefund,
} from "#shared/payment-runtime/provider-refund.ts";
import { REFUND_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { paymentCharge } from "./fixtures.ts";

const charge = (pending = false) =>
  paymentCharge({
    pendingRefund: pending ? REFUND_RESOURCE : null,
    refundState: pending ? "pending" : "requested",
  });

test("builds every typed provider refund outcome", () => {
  expect(completedProviderRefund(charge(), REFUND_RESOURCE)).toEqual({
    amount: { amount: 1_000, currency: "GBP" },
    refund: REFUND_RESOURCE,
    status: "completed",
  });
  expect(pendingProviderRefund(charge(), REFUND_RESOURCE)).toEqual({
    amount: { amount: 1_000, currency: "GBP" },
    refund: REFUND_RESOURCE,
    status: "pending",
  });
  expect(completedProviderRefund(charge(), null)).toEqual({
    amount: { amount: 1_000, currency: "GBP" },
    status: "completed",
  });
  expect(
    partialProviderRefund({ amount: 400, currency: "GBP" }, REFUND_RESOURCE),
  ).toEqual({
    amount: { amount: 400, currency: "GBP" },
    refund: REFUND_RESOURCE,
    status: "partial",
  });
  expect(failedProviderRefund(charge())).toEqual({
    amount: { amount: 0, currency: "GBP" },
    reason: "provider_failed",
    status: "failed",
  });
});

test("polls a persisted refund instead of sending another request", async () => {
  const calls: string[] = [];
  const refund = makeProviderRefund(
    (value) => {
      calls.push(`observe:${value.pendingRefund?.id}`);
      return Promise.resolve(pendingProviderRefund(value, value.pendingRefund));
    },
    (value, key) => {
      calls.push(`request:${key}`);
      return Promise.resolve(completedProviderRefund(value, REFUND_RESOURCE));
    },
  );

  await refund(charge(), "new-key");
  await refund(charge(true), "old-key");

  expect(calls).toEqual(["request:new-key", `observe:${REFUND_RESOURCE.id}`]);
});

test("maps a null provider response to a typed failure", async () => {
  const failed = makeProviderRefundRequest(
    () => Promise.resolve(null),
    (value) => completedProviderRefund(value, REFUND_RESOURCE),
  );
  const completed = makeProviderRefundRequest(
    () => Promise.resolve({ refund: REFUND_RESOURCE }),
    (value, result) => completedProviderRefund(value, result.refund),
  );

  expect(await failed(charge(), "failed-key")).toEqual(
    failedProviderRefund(charge()),
  );
  expect(await completed(charge(), "completed-key")).toEqual(
    completedProviderRefund(charge(), REFUND_RESOURCE),
  );
});
