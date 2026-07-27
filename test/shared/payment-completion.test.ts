import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  BookingCompletionEffectSchema,
  bookingCompletion,
  type PaymentCompletion,
  type PaymentCompletionEffect,
  PaymentCompletionSchema,
  PlaceholderRefundEffectSchema,
  placeholderRefundCompletion,
} from "#shared/payment-completion.ts";
import {
  PAYMENT_INTENT,
  PAYMENT_PLACEHOLDER_RESULT,
} from "#test/shared/db/payments/fixtures.ts";

const expectPendingEffects = (
  completion: PaymentCompletion,
  effects: readonly PaymentCompletionEffect[],
): void => {
  expect(Object.keys(completion.effects).toSorted()).toEqual(
    [...effects].toSorted(),
  );
  expect(new Set(Object.values(completion.effects))).toEqual(
    new Set(["pending"]),
  );
  expect(v.parse(PaymentCompletionSchema, completion)).toEqual(completion);
};

test("creates every required booking effect as pending", () => {
  const completion = bookingCompletion(
    PAYMENT_INTENT,
    {
      flow: "registration",
      listingId: 7,
      occurredAt: "2026-07-26T12:00:00.000Z",
      promos: [{ delta: -200, modifierId: 3, name: "SAVE" }],
    },
    ["ticket-one"],
  );

  expectPendingEffects(completion, BookingCompletionEffectSchema.options);
});

test("creates every required placeholder refund effect as pending", () => {
  const completion = placeholderRefundCompletion(
    PAYMENT_INTENT,
    {
      amount: 1_000,
      listingId: 7,
      occurredAt: "2026-07-26T12:00:00.000Z",
      spec: {
        code: "price_changed",
        detail: "The price changed",
        reason: "the listing price changed while they were paying",
      },
    },
    PAYMENT_PLACEHOLDER_RESULT,
  );

  expectPendingEffects(completion, PlaceholderRefundEffectSchema.options);
});

test("rejects a balance completion for registration input", () => {
  expect(() =>
    bookingCompletion(
      PAYMENT_INTENT,
      {
        flow: "balance",
        listingId: 7,
        occurredAt: "2026-07-26T12:00:00.000Z",
        promos: [],
      },
      [],
    ),
  ).toThrow("flow must match");
});
