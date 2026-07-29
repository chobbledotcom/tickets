import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentCaseStateSchema,
  PaymentIgnoreReasonSchema,
  PaymentPendingReasonSchema,
  PaymentRefundStateSchema,
  PaymentResolutionSchema,
  PaymentSessionStateSchema,
} from "#shared/payment-state/lifecycle.ts";
import {
  chargeLeg,
  noPaymentRequiredObservation,
  partlyRefundedObservation,
  paymentObservation,
  refundedObservation,
  refundObservation,
  sessionResource,
} from "./fixtures.ts";

describe("payment lifecycle", () => {
  test("validates every payment resolution", () => {
    const observation = paymentObservation();
    const resolutions = [
      { observation, status: "ready" },
      {
        observation: paymentObservation({ status: "pending" }),
        reason: "payment_pending",
        status: "pending",
      },
      { observation: refundedObservation(), status: "fully_refunded" },
      { reason: "timed_out", resource: sessionResource, status: "retry" },
      {
        issue: { kind: "partial_refund" },
        observation: partlyRefundedObservation(),
        resource: sessionResource,
        status: "conflict",
      },
      { reason: "not_ours", resource: sessionResource, status: "ignore" },
    ] as const;
    expect(
      resolutions.map((item) => v.parse(PaymentResolutionSchema, item).status),
    ).toEqual([
      "ready",
      "pending",
      "fully_refunded",
      "retry",
      "conflict",
      "ignore",
    ]);
  });

  test("refuses a fully refunded payment with money still held", () => {
    // The charge gave back only half, so the money is not finally returned.
    const observation = paymentObservation({
      charges: [
        chargeLeg({ confirmedRefunded: { amount: 50, currency: "GBP" } }),
      ],
    });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("refuses a fully refunded payment that never took any money", () => {
    // With no charge there is nothing to have given back.
    const observation = paymentObservation({ charges: undefined });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("refuses a fully refunded payment holding money on a second charge", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({ confirmedRefunded: { amount: 100, currency: "GBP" } }),
        chargeLeg(),
      ],
    });

    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation,
        status: "fully_refunded",
      }),
    ).toThrow();
  });

  test("accepts a payment waiting on a refund that is really going", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({ refunds: [refundObservation({ status: "pending" })] }),
      ],
    });

    expect(
      v.parse(PaymentResolutionSchema, {
        observation,
        reason: "refund_pending",
        status: "pending",
      }).status,
    ).toBe("pending");
  });

  test("refuses a payment waiting on a refund when it took no money", () => {
    // No charge means there is nothing a refund could be coming back from.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation: paymentObservation({ charges: undefined }),
        reason: "refund_pending",
        status: "pending",
      }),
    ).toThrow();
  });

  test("refuses a payment waiting on a refund with nothing in flight", () => {
    // Nothing to find on the next look, so it would be looked at forever.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation: paymentObservation(),
        reason: "refund_pending",
        status: "pending",
      }),
    ).toThrow();
  });

  for (const [reason, status] of [
    ["payment_pending", "paid"],
    ["refund_pending", "pending"],
  ] as const) {
    test(`refuses ${reason} beside a reading that says ${status}`, () => {
      expect(() =>
        v.parse(PaymentResolutionSchema, {
          observation: paymentObservation({ status }),
          reason,
          status: "pending",
        }),
      ).toThrow();
    });
  }

  // A problem spotted inside a reading has to carry that reading, and the two
  // problems that mean "the reading itself failed" have none to carry. Either
  // way round leaves the owner looking at the wrong money problem.
  for (const [name, issue, withEvidence] of [
    [
      "a problem spotted in a reading, with none shown",
      "partial_refund",
      false,
    ],
    ["a failed read that somehow shows a reading", "missing_resource", true],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(() =>
        v.parse(PaymentResolutionSchema, {
          issue: { kind: issue },
          resource: sessionResource,
          status: "conflict",
          ...(withEvidence ? { observation: paymentObservation() } : {}),
        }),
      ).toThrow();
    });
  }

  test("accepts a failed read as a problem with nothing to show", () => {
    expect(
      v.parse(PaymentResolutionSchema, {
        issue: { kind: "missing_resource" },
        resource: sessionResource,
        status: "conflict",
      }).status,
    ).toBe("conflict");
  });

  test("refuses a problem that names a different checkout to its evidence", () => {
    // The problem would send a worker, or the owner, to the wrong payment.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        issue: { kind: "partial_refund" },
        observation: partlyRefundedObservation(),
        resource: { ...sessionResource, id: "another_checkout" },
        status: "conflict",
      }),
    ).toThrow();
  });

  test("counts a checkout that needed no money as ready", () => {
    const observation = noPaymentRequiredObservation();

    expect(
      v.parse(PaymentResolutionSchema, { observation, status: "ready" }).status,
    ).toBe("ready");
  });

  for (const status of ["pending", "failed"] as const) {
    test(`refuses a ready payment whose reading is ${status}`, () => {
      const observation = paymentObservation({ status });

      expect(() =>
        v.parse(PaymentResolutionSchema, { observation, status: "ready" }),
      ).toThrow();
    });
  }

  // Money part-returned is a problem for the owner, money fully returned is
  // its own answer, and money on its way back is waited on. None of them is a
  // booking waiting to be made.
  for (const [name, charge] of [
    [
      "some of the money has gone back",
      chargeLeg({ confirmedRefunded: { amount: 40, currency: "GBP" } }),
    ],
    [
      "all of the money has gone back",
      chargeLeg({ confirmedRefunded: { amount: 100, currency: "GBP" } }),
    ],
    [
      "money is still on its way back",
      chargeLeg({ refunds: [refundObservation({ status: "pending" })] }),
    ],
    // The money is all still here, so every other rule is happy — but somebody
    // asked for it back and the provider could not do it. The resolver calls
    // that a problem for the owner, so "ready" would be a second, different
    // answer to the same reading.
    [
      "a refund was tried and could not be done",
      chargeLeg({
        refunds: [refundObservation({ reason: "declined", status: "failed" })],
      }),
    ],
  ] as const) {
    test(`refuses a ready payment where ${name}`, () => {
      expect(() =>
        v.parse(PaymentResolutionSchema, {
          observation: paymentObservation({ charges: [charge] }),
          status: "ready",
        }),
      ).toThrow();
    });
  }

  test("refuses a ready payment that says it was paid but took nothing", () => {
    // A paid reading with no charge is a payment nobody can find, which the
    // resolver raises as a problem rather than treating as ready to book.
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        observation: paymentObservation({ charges: undefined }),
        status: "ready",
      }),
    ).toThrow();
  });

  test("refuses a ready payment that needed no money but took some", () => {
    const observation = paymentObservation({ status: "no_payment_required" });

    expect(() =>
      v.parse(PaymentResolutionSchema, { observation, status: "ready" }),
    ).toThrow();
  });

  test("defines every pending and ignore reason", () => {
    expect(PaymentPendingReasonSchema.options).toEqual([
      "payment_pending",
      "refund_pending",
    ]);
    expect(PaymentIgnoreReasonSchema.options).toEqual([
      "not_ours",
      "payment_failed",
      "unproven_invalid_data",
      "unproven_missing_resource",
    ]);
  });

  test("defines durable session, case, and refund states", () => {
    expect(PaymentSessionStateSchema.options).toEqual([
      "created",
      "pending",
      "ready",
      "processing",
      "completed",
      "failed",
      "refunding",
      "fully_refunded",
      "needs_action",
    ]);
    expect(PaymentCaseStateSchema.options).toEqual([
      "retrying",
      "needs_action",
      "resolved",
    ]);
    // "unknown" is what a charge copied from an older version carries: the old
    // record never said what happened to its refund. The table demands it for
    // those rows, so the words for a refund state have to include it or a
    // copied charge could not be read back at all.
    expect(PaymentRefundStateSchema.options).toEqual([
      "none",
      "requested",
      "pending",
      "partial",
      "completed",
      "failed",
      "unknown",
    ]);
  });
});
