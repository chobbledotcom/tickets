import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { BookingIntentSchema } from "#shared/booking-intent.ts";
import {
  ObservedPaymentStatusSchema,
  PaymentFactsSchema,
  PaymentModeSchema,
  PaymentObservationSchema,
  PaymentOwnershipProofSchema,
  ProviderInvalidReasonSchema,
  ProviderReadSchema,
  ProviderUnavailableReasonSchema,
  paymentObservationResources,
  signedPaymentOwnership,
  stagedPaymentOwnership,
} from "#shared/payment-state/observation.ts";
import {
  chargeLeg,
  chargeResource,
  foundRead,
  noPaymentRequiredObservation,
  paymentObservation,
  refundObservation,
  refundResource,
  sessionResource,
  validationMessage,
} from "./fixtures.ts";

describe("payment observations", () => {
  test("validates signed and staged ownership proof", () => {
    const proofs = [
      signedPaymentOwnership("payment_1", "signature_1"),
      stagedPaymentOwnership("payment_2", "stage_1"),
    ] as const;

    expect(
      proofs.map((proof) => v.parse(PaymentOwnershipProofSchema, proof).method),
    ).toEqual(["signed", "staged"]);
  });

  test("requires a parsed booking intent with details", () => {
    expect(
      v.parse(BookingIntentSchema, paymentObservation().bookingIntent),
    ).toEqual(paymentObservation().bookingIntent);
    expect(v.safeParse(BookingIntentSchema, { items: [1] }).success).toBe(
      false,
    );
    expect(v.safeParse(BookingIntentSchema, "items").success).toBe(false);
  });

  // Two rules the booking facts carry that a shape check alone would miss.
  for (const [name, broken] of [
    [
      "paying off a balance covers more than one line",
      {
        balanceAttendeeId: 7,
        items: [
          { e: 1, p: 100, q: 1 },
          { e: 2, p: 100, q: 1 },
        ],
      },
    ],
    ["the deposit cannot be read", { reservationAmount: "banana" }],
  ] as const) {
    test(`refuses booking facts where ${name}`, () => {
      expect(
        v.safeParse(BookingIntentSchema, {
          ...paymentObservation().bookingIntent,
          ...broken,
        }).success,
      ).toBe(false);
    });
  }

  test("accepts a balance payment for its single line", () => {
    expect(
      v.safeParse(BookingIntentSchema, {
        ...paymentObservation().bookingIntent,
        balanceAttendeeId: 7,
        items: [{ e: 1, p: 100, q: 1 }],
        reservationAmount: "10%",
      }).success,
    ).toBe(true);
  });

  test("validates complete and charge-free observations", () => {
    expect(v.parse(PaymentObservationSchema, paymentObservation()).status).toBe(
      "paid",
    );
    const withoutCharges = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    expect(v.parse(PaymentObservationSchema, withoutCharges)).toEqual(
      withoutCharges,
    );
  });

  test("derives identifying payment facts from the observation schema", () => {
    const observation = paymentObservation();
    const facts = {
      accountId: observation.accountId,
      bookingIntent: observation.bookingIntent,
      expected: observation.expected,
      mode: observation.mode,
    };

    expect(v.parse(PaymentFactsSchema, facts)).toEqual(facts);
  });

  for (const [name, change] of [
    ["empty account", { accountId: "" }],
    ["bad mode", { mode: "sandbox" }],
    ["bad status", { status: "complete" }],
    ["impossible date", { createdAt: "2026-02-30T12:00:00.000Z" }],
    ["empty intent", { bookingIntent: {} }],
    ["empty charge list", { charges: [] }],
  ] as const) {
    test(`rejects an observation with ${name}`, () => {
      expect(
        v.safeParse(PaymentObservationSchema, {
          ...paymentObservation(),
          ...change,
        }).success,
      ).toBe(false);
    });
  }

  test("validates every provider read result", () => {
    const reads = [
      foundRead(),
      {
        reason: "not_found",
        requested: sessionResource,
        status: "missing",
      },
      {
        reason: "timed_out",
        requested: sessionResource,
        status: "unavailable",
      },
      {
        reason: "malformed_response",
        requested: sessionResource,
        status: "invalid",
      },
    ] as const;

    expect(
      reads.map((read) => v.parse(ProviderReadSchema, read).status),
    ).toEqual(["found", "missing", "unavailable", "invalid"]);
  });

  test("validates a found pending session without charge facts", () => {
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    expect(v.parse(ProviderReadSchema, foundRead(observation)).status).toBe(
      "found",
    );
  });

  test("accepts a charge the payment has not recorded yet", () => {
    // A checkout that is not paid yet can be asked about by a charge the site
    // has never seen: the provider made it after the last reading. It still
    // belongs to this payment, because it hangs off this checkout.
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });

    expect(
      v.parse(ProviderReadSchema, {
        ...foundRead(observation),
        requested: chargeResource,
        returned: chargeResource,
      }).status,
    ).toBe("found");
  });

  test("refuses a charge hanging off somebody else's checkout", () => {
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    const otherCheckout = { ...chargeResource, parentId: "cs_someone_else" };

    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(observation),
        requested: otherCheckout,
        returned: otherCheckout,
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("refuses a refund that claims to hang off the checkout", () => {
    // A refund always hangs off a charge. One naming the checkout as its parent
    // is malformed, so it must not slip through on the not-paid-yet allowance
    // that exists for charges the site has not recorded.
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    const refundOnCheckout = {
      ...refundResource,
      parentId: sessionResource.id,
    };

    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(observation),
        requested: refundOnCheckout,
        returned: refundOnCheckout,
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("refuses an unrecorded charge from a different provider", () => {
    // Two providers can hand out the same id, so a charge only belongs to this
    // checkout when the provider matches as well as the parent.
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    const otherProvider = {
      ...chargeResource,
      kind: "square_payment" as const,
      provider: "square" as const,
    };

    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(observation),
        requested: otherProvider,
        returned: otherProvider,
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("refuses an unrecorded charge on a payment that needed no money", () => {
    // The allowance exists because a checkout still going may have made a
    // charge since the last reading. A payment that needed no money is
    // finished and has no charges, so one turning up contradicts it.
    const observation = noPaymentRequiredObservation();

    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(observation),
        requested: chargeResource,
        returned: chargeResource,
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("refuses an unrecorded charge once the payment is paid", () => {
    // Once the money is in, the charges are known. A charge that is not among
    // them is not this payment's, even if it names this checkout as its parent.
    const observation = paymentObservation({ charges: undefined });

    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(observation),
        requested: chargeResource,
        returned: chargeResource,
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("defines every unavailable and invalid provider reason", () => {
    expect(PaymentModeSchema.options).toEqual(["test", "live"]);
    expect(ObservedPaymentStatusSchema.options).toEqual([
      "pending",
      "paid",
      "no_payment_required",
      "failed",
    ]);
    expect(ProviderUnavailableReasonSchema.options).toEqual([
      "network_error",
      "provider_unavailable",
      "rate_limited",
      "timed_out",
    ]);
    expect(ProviderInvalidReasonSchema.options).toEqual([
      "malformed_response",
      "mismatched_account",
      "missing_documented_resource",
      "mismatched_id",
      "mismatched_parent",
      "unsupported_status",
    ]);
  });

  test("requires a returned resource to match every requested id", () => {
    expect(
      validationMessage(ProviderReadSchema, {
        ...foundRead(),
        requested: { ...sessionResource, id: "cs_other" },
      }),
    ).toBe("Returned provider resource must match the requested resource");
    expect(
      v.safeParse(ProviderReadSchema, {
        observation: paymentObservation(),
        requested: chargeResource,
        returned: { ...chargeResource, parentId: "cs_other" },
        status: "found",
      }).success,
    ).toBe(false);
  });

  test("requires a returned resource to belong to the observation", () => {
    const observation = paymentObservation();
    expect(
      validationMessage(ProviderReadSchema, {
        observation,
        requested: { ...chargeResource, id: "ch_other" },
        returned: { ...chargeResource, id: "ch_other" },
        status: "found",
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
    const wrongParent = { ...chargeResource, parentId: "cs_other" };
    expect(
      validationMessage(ProviderReadSchema, {
        observation,
        requested: wrongParent,
        returned: wrongParent,
        status: "found",
      }),
    ).toBe("Returned provider resource must belong to the payment observation");
  });

  test("reports an invalid creation time", () => {
    expect(
      validationMessage(PaymentObservationSchema, {
        ...paymentObservation(),
        createdAt: "2026-02-30T12:00:00.000Z",
      }),
    ).toBe("Payment creation time must be a real instant");
  });

  test("finds returned charge and refund resources in an observation", () => {
    const observation = paymentObservation({
      charges: [chargeLeg({ refunds: [refundObservation()] })],
    });
    for (const resource of [chargeResource, refundObservation().refund]) {
      expect(
        v.safeParse(ProviderReadSchema, {
          observation,
          requested: resource,
          returned: resource,
          status: "found",
        }).success,
      ).toBe(true);
    }
  });

  test("lists every resource carried by an observation", () => {
    const observation = paymentObservation({
      charges: [chargeLeg({ refunds: [refundObservation()] })],
    });

    expect(paymentObservationResources(observation)).toEqual([
      sessionResource,
      chargeResource,
      refundObservation().refund,
    ]);
    expect(
      paymentObservationResources(
        paymentObservation({ charges: undefined, status: "pending" }),
      ),
    ).toEqual([sessionResource]);
  });

  test("validates returned evidence on invalid reads", () => {
    const parsed = v.parse(ProviderReadSchema, {
      ownership: paymentObservation().ownership,
      reason: "mismatched_id",
      requested: sessionResource,
      returned: { ...sessionResource, id: "cs_other" },
      status: "invalid",
    });
    expect(parsed).toMatchObject({
      returned: { id: "cs_other" },
      status: "invalid",
    });
  });
});
