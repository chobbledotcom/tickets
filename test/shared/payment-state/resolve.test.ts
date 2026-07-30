import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import { resolvePayment } from "#shared/payment-state/resolve.ts";
import type { RefundObservation } from "#shared/payment-state/resources.ts";
import {
  chargeLeg,
  chargeResource,
  foundRead,
  noPaymentRequiredObservation,
  paymentObservation,
  refundObservation,
  refundResource,
  sessionResource,
} from "#test-utils/payment-state.ts";

const ownership = paymentObservation().ownership;

const issueKind = (read: ProviderRead): string | undefined => {
  const result = resolvePayment(read);
  return result.status === "conflict" ? result.issue.kind : undefined;
};

describe("payment resolver", () => {
  for (const reason of [
    "network_error",
    "provider_unavailable",
    "rate_limited",
    "timed_out",
  ] as const) {
    test(`retries ${reason}`, () => {
      expect(
        resolvePayment({
          ownership,
          reason,
          requested: sessionResource,
          status: "unavailable",
        }),
      ).toEqual({ reason, resource: sessionResource, status: "retry" });
    });
  }

  test("ignores an unavailable resource without ownership proof", () => {
    expect(
      resolvePayment({
        reason: "timed_out",
        requested: sessionResource,
        status: "unavailable",
      }),
    ).toEqual({
      reason: "not_ours",
      resource: sessionResource,
      status: "ignore",
    });
  });

  test("opens a case for a missing owned resource", () => {
    expect(
      resolvePayment({
        ownership,
        reason: "not_found",
        requested: sessionResource,
        status: "missing",
      }),
    ).toEqual({
      issue: { kind: "missing_resource" },
      resource: sessionResource,
      status: "conflict",
    });
  });

  test("ignores a missing resource without ownership proof", () => {
    expect(
      resolvePayment({
        reason: "not_found",
        requested: sessionResource,
        status: "missing",
      }),
    ).toEqual({
      reason: "unproven_missing_resource",
      resource: sessionResource,
      status: "ignore",
    });
  });

  test("opens a case for invalid owned provider data", () => {
    expect(
      resolvePayment({
        ownership,
        reason: "mismatched_parent",
        requested: sessionResource,
        status: "invalid",
      }),
    ).toEqual({
      issue: { kind: "invalid_provider_data", reason: "mismatched_parent" },
      resource: sessionResource,
      status: "conflict",
    });
  });

  test("ignores invalid data without ownership proof", () => {
    expect(
      resolvePayment({
        reason: "malformed_response",
        requested: sessionResource,
        status: "invalid",
      }),
    ).toEqual({
      reason: "unproven_invalid_data",
      resource: sessionResource,
      status: "ignore",
    });
  });

  test("keeps a pending payment pending", () => {
    // Nothing naming the money yet is normal before payment, not a
    // disagreement about it.
    const observation = paymentObservation({
      charges: undefined,
      status: "pending",
    });
    expect(resolvePayment(foundRead(observation))).toEqual({
      observation,
      reason: "payment_pending",
      status: "pending",
    });
  });

  test("accepts a completed zero-value checkout without a charge", () => {
    const observation = noPaymentRequiredObservation();

    expect(resolvePayment(foundRead(observation))).toEqual({
      observation,
      status: "ready",
    });
  });

  test("rejects a positive checkout that has no charge", () => {
    const observation = paymentObservation({
      charges: undefined,
      status: "no_payment_required",
    });

    expect(issueKind(foundRead(observation))).toBe("paid_without_charge");
  });

  test("rejects a checkout needing no payment that charged something", () => {
    // Nothing was due, so a provider total above zero does not add up and the
    // payment cannot be treated as settled.
    const observation = paymentObservation({
      charges: undefined,
      expected: { amount: 0, currency: "GBP" },
      providerTotal: { amount: 500, currency: "GBP" },
      status: "no_payment_required",
    });

    expect(issueKind(foundRead(observation))).toBe("provider_total_mismatch");
  });

  test("ignores a failed payment", () => {
    const observation = paymentObservation({
      charges: undefined,
      status: "failed",
    });
    expect(resolvePayment(foundRead(observation))).toEqual({
      reason: "payment_failed",
      resource: sessionResource,
      status: "ignore",
    });
  });

  test("marks an exact unrefunded capture ready", () => {
    const observation = paymentObservation();
    expect(resolvePayment(foundRead(observation))).toEqual({
      observation,
      status: "ready",
    });
  });

  test("reports a paid session without a refundable charge", () => {
    expect(
      issueKind(foundRead(paymentObservation({ charges: undefined }))),
    ).toBe("paid_without_charge");
  });

  for (const [name, observation, expected] of [
    [
      "provider currency",
      paymentObservation({ providerTotal: { amount: 100, currency: "USD" } }),
      "currency_mismatch",
    ],
    [
      "charge currency",
      paymentObservation({
        charges: [chargeLeg({ captured: { amount: 100, currency: "USD" } })],
      }),
      "currency_mismatch",
    ],
    [
      "provider total",
      paymentObservation({ providerTotal: { amount: 99, currency: "GBP" } }),
      "provider_total_mismatch",
    ],
    [
      "partial capture",
      paymentObservation({
        charges: [chargeLeg({ captured: { amount: 99, currency: "GBP" } })],
      }),
      "partial_charge",
    ],
    [
      "excess capture",
      paymentObservation({
        charges: [chargeLeg({ captured: { amount: 101, currency: "GBP" } })],
      }),
      "capture_total_mismatch",
    ],
  ] as const) {
    test(`reports a ${name} disagreement`, () => {
      expect(issueKind(foundRead(observation))).toBe(expected);
    });
  }

  test("reports a charge from the wrong provider", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          resource: {
            id: "payment_1",
            kind: "square_payment",
            parentId: "order_1",
            provider: "square",
          },
        }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("resource_mismatch");
  });

  test("reports a charge with the wrong parent", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({ resource: { ...chargeResource, parentId: "cs_other" } }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("resource_mismatch");
  });

  test("reports a refund with the wrong charge parent", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          refunds: [
            refundObservation({
              refund: { ...refundResource, parentId: "pi_other" },
            }),
          ],
        }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("resource_mismatch");
  });

  test("reports confirmed and observed refunds above the capture", () => {
    for (const charge of [
      chargeLeg({ confirmedRefunded: { amount: 101, currency: "GBP" } }),
      chargeLeg({
        refunds: [
          refundObservation({ amount: { amount: 101, currency: "GBP" } }),
        ],
      }),
    ]) {
      expect(
        issueKind(foundRead(paymentObservation({ charges: [charge] }))),
      ).toBe("refund_exceeds_capture");
    }
  });

  test("reports duplicate charge ids before amount classification", () => {
    const charges = [
      chargeLeg({ captured: { amount: 50, currency: "GBP" } }),
      chargeLeg({ captured: { amount: 50, currency: "GBP" } }),
    ];
    expect(issueKind(foundRead(paymentObservation({ charges })))).toBe(
      "duplicate_charge",
    );
  });

  test("reports more than one completed charge", () => {
    const charges = [
      chargeLeg({ captured: { amount: 50, currency: "GBP" } }),
      chargeLeg({
        captured: { amount: 50, currency: "GBP" },
        resource: { ...chargeResource, id: "ch_2" },
      }),
    ];
    expect(issueKind(foundRead(paymentObservation({ charges })))).toBe(
      "multiple_charges",
    );
  });

  test("reports duplicate refund ids", () => {
    // Half the money each, so the two together still fit inside what was
    // taken: the only thing wrong with this reading is the repeated id.
    const half = refundObservation({ amount: { amount: 50, currency: "GBP" } });
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          confirmedRefunded: { amount: 100, currency: "GBP" },
          refunds: [half, half],
        }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("duplicate_refund");
  });

  test("reports more than one pending refund", () => {
    const pending = (id: string): RefundObservation => ({
      amount: { amount: 50, currency: "GBP" },
      refund: { ...refundResource, id },
      status: "pending",
    });
    const observation = paymentObservation({
      charges: [chargeLeg({ refunds: [pending("re_1"), pending("re_2")] })],
    });
    expect(issueKind(foundRead(observation))).toBe("multiple_pending_refunds");
  });

  test("keeps a pending refund id for polling", () => {
    const pending = refundObservation({ status: "pending" });
    const observation = paymentObservation({
      charges: [chargeLeg({ refunds: [pending] })],
    });
    const result = resolvePayment(foundRead(observation));
    expect(result.status).toBe("pending");
    expect(result.status === "pending" ? result.reason : undefined).toBe(
      "refund_pending",
    );
    expect(pending.refund?.id).toBe("re_1");
  });

  test("marks authoritative full refunds terminal", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          confirmedRefunded: { amount: 100, currency: "GBP" },
          refunds: [refundObservation()],
        }),
      ],
    });
    expect(resolvePayment(foundRead(observation))).toEqual({
      observation,
      status: "fully_refunded",
    });
  });

  test("reports a partial refund", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          confirmedRefunded: { amount: 40, currency: "GBP" },
          refunds: [
            refundObservation({ amount: { amount: 40, currency: "GBP" } }),
          ],
        }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("partial_refund");
    expect(
      issueKind(
        foundRead(
          paymentObservation({
            charges: [
              chargeLeg({
                confirmedRefunded: { amount: 1, currency: "GBP" },
              }),
            ],
          }),
        ),
      ),
    ).toBe("partial_refund");
  });

  test("reports a failed refund", () => {
    const observation = paymentObservation({
      charges: [
        chargeLeg({
          refunds: [
            refundObservation({ reason: "rejected", status: "failed" }),
          ],
        }),
      ],
    });
    expect(issueKind(foundRead(observation))).toBe("failed_refund");
  });
});
