import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("payment runtime provider resources", { db: true }, () => {
  test("builds each provider resource with its exact hierarchy", () => {
    expect(PAYMENT_PROVIDER_RESOURCES.square.charge("pay", "order")).toEqual({
      id: "pay",
      kind: "square_payment",
      parentId: "order",
      provider: "square",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.square.session("order")).toEqual({
      id: "order",
      kind: "square_order",
      provider: "square",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.stripe.charge("pi", "cs")).toEqual({
      id: "pi",
      kind: "stripe_payment_intent",
      parentId: "cs",
      provider: "stripe",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.sumup.charge("txn", "checkout")).toEqual({
      id: "txn",
      kind: "sumup_transaction",
      parentId: "checkout",
      provider: "sumup",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.sumup.session("checkout")).toEqual({
      id: "checkout",
      kind: "sumup_checkout",
      provider: "sumup",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.stripe.refund("re", "pi")).toEqual({
      id: "re",
      kind: "stripe_refund",
      parentId: "pi",
      provider: "stripe",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.square.refund("refund", "pay")).toEqual({
      id: "refund",
      kind: "square_refund",
      parentId: "pay",
      provider: "square",
    });
    expect(PAYMENT_PROVIDER_RESOURCES.sumup.refund("refund", "txn")).toEqual({
      id: "refund",
      kind: "sumup_refund",
      parentId: "txn",
      provider: "sumup",
    });
  });
});
