import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
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
import { BookingIntentSchema } from "#shared/payments.ts";
import {
  chargeLeg,
  chargeResource,
  foundRead,
  paymentObservation,
  refundObservation,
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
    if (parsed.status !== "invalid") throw new Error("Expected invalid read");
    expect(parsed.status).toBe("invalid");
    expect(parsed.returned?.id).toBe("cs_other");
  });
});
