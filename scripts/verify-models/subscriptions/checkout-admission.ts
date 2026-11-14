/** Admission facts call both production gates, including every refusal. */
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import {
  subscriptionCheckoutError,
  subscriptionOrderError,
} from "#shared/subscriptions/checkout-rules.ts";
import { PaymentProviderSchema } from "#types";
import type { CheckoutFacts } from "./checkout-facts.ts";

export const item: CheckoutItem = {
  listingId: 71,
  name: "Model club",
  quantity: 1,
  recurring: { interval: "month", price: 501 },
  slug: "model-club",
  unitPrice: 1000,
};
export const intentOf = (items: CheckoutItem[]): CheckoutIntent => ({
  address: "",
  date: null,
  email: "model@example.invalid",
  items,
  name: "Synthetic member",
  phone: "",
  special_instructions: "",
  taxPolicy: { mode: "none" },
});

export const admissionCases = () => {
  const { recurring: _, ...ordinary } = item;
  const withItem = (
    shape: string,
    total: number,
    changes: Partial<CheckoutItem>,
  ) => ({
    intent: intentOf([{ ...item, ...changes }]),
    shape,
    total,
  });
  return [
    { intent: intentOf([ordinary]), shape: "ordinary", total: 0 },
    { intent: intentOf([item]), shape: "single", total: 1000 },
    {
      intent: intentOf([item, { ...ordinary, listingId: 72 }]),
      shape: "extra",
      total: 2000,
    },
    {
      intent: intentOf([item, { ...item, listingId: 72 }]),
      shape: "multiple",
      total: 2000,
    },
    withItem("package", 1000, { packageGroupId: 9 }),
    {
      intent: {
        ...intentOf([item]),
        allocations: [{ childId: 71, parentId: 72, qty: 1 }],
      },
      shape: "addon",
      total: 1000,
    },
    {
      intent: { ...intentOf([item]), reservationAmount: "10%" },
      shape: "deposit",
      total: 100,
    },
    {
      intent: { ...intentOf([item]), balanceAttendeeId: 93 },
      shape: "balance",
      total: 1000,
    },
    withItem("zero", 0, { unitPrice: 0 }),
    withItem("quantity-two", 2000, { quantity: 2 }),
    withItem("quantity-zero", 0, { quantity: 0 }),
  ];
};

export const admissionFacts = (): {
  facts: CheckoutFacts["admissions"];
  universe: string[];
} => {
  const facts: CheckoutFacts["admissions"] = [];
  const universe: string[] = [];
  for (const provider of [...PaymentProviderSchema.options, null]) {
    for (const { shape, intent, total } of admissionCases()) {
      const scenario = `${provider ?? "none"}-${shape}`;
      universe.push(scenario);
      const recurring = intent.items.filter(
        (line) => line.recurring !== undefined,
      );
      facts.push({
        attempt: 1,
        checkoutAccepted: subscriptionCheckoutError(provider, intent) === null,
        orderAccepted: subscriptionOrderError(provider, intent, total) === null,
        own: recurring.every(
          (line) =>
            line.packageGroupId === undefined &&
            !(intent.allocations ?? []).some(
              (allocation) => allocation.childId === line.listingId,
            ),
        ),
        partPayment:
          intent.balanceAttendeeId !== undefined ||
          intent.reservationAmount !== undefined,
        provider: provider ?? "none",
        scenario,
        shape,
        subscriptions: recurring.length,
        total,
      });
    }
  }
  return { facts, universe };
};
