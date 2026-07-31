import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createPaymentDecisionForm,
  paymentSelectionFromValue,
  paymentSelectionValue,
} from "#routes/admin/payments/form.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  legacyPaymentOperatorCase,
  provenPaymentOperatorCase,
} from "#test/shared/payment-runtime/fixtures.ts";

describe("admin payment decision form", () => {
  test("uses stable values for every decision kind", () => {
    expect(paymentSelectionValue({ kind: "complete_booking" })).toBe(
      "complete_booking",
    );
    expect(
      paymentSelectionValue({
        accountId: "square-account",
        kind: "assign_provider",
        mode: "test",
        provider: "square",
      }),
    ).toBe("assign_provider:square:test:square-account");
  });

  test("builds current payment options with no default choice", () => {
    const context = provenPaymentOperatorCase();
    context.case.reason = "partial_refund";

    const form = createPaymentDecisionForm(context, []);

    expect(form.fields[0].options).toEqual([
      { label: "Choose a decision", value: "" },
      {
        hint: "Use the saved payment proof to complete the booking.",
        label: "Complete the proven booking",
        value: "complete_booking",
      },
      {
        hint: "Refund the amount still held across every charge.",
        label: "Refund all money still held",
        value: "refund_remaining",
      },
      {
        hint: "Record that every charge has already been fully refunded.",
        label: "Confirm the full refund",
        value: "confirm_fully_refunded",
      },
    ]);
  });

  test("labels each configured provider assignment", () => {
    const form = createPaymentDecisionForm(legacyPaymentOperatorCase(), [
      { accountId: "square-account", mode: "test", provider: "square" },
    ]);

    expect(form.fields[0].options[1]).toEqual({
      hint: "Check this older payment with the configured account. Unclear facts will stay open.",
      label:
        "Assign the older payment to Square (test, account square-account)",
      value: "assign_provider:square:test:square-account",
    });
  });

  test("trims a valid reason and parses the exact revision", () => {
    const context = provenPaymentOperatorCase();
    const form = createPaymentDecisionForm(context, []);

    expect(
      form.validate(
        new FormParams({
          case_revision: "7",
          decision: "complete_booking",
          reason: "  Checked all facts  ",
        }),
      ),
    ).toEqual({
      valid: true,
      values: {
        case_revision: 7,
        decision: "complete_booking",
        reason: "Checked all facts",
      },
    });
  });

  test("rejects a reason shorter than three characters", () => {
    const form = createPaymentDecisionForm(provenPaymentOperatorCase(), []);

    expect(
      form.validate(
        new FormParams({
          case_revision: "1",
          decision: "complete_booking",
          reason: " x ",
        }),
      ),
    ).toEqual({
      error: "The reason must be at least 3 characters.",
      valid: false,
    });
  });

  test("resolves current and provider choices from rendered values", () => {
    const current = provenPaymentOperatorCase();
    const legacy = legacyPaymentOperatorCase();
    const accounts = [
      {
        accountId: "square-account",
        mode: "test" as const,
        provider: "square" as const,
      },
    ];

    expect(paymentSelectionFromValue("complete_booking", current, [])).toEqual({
      kind: "complete_booking",
    });
    expect(
      paymentSelectionFromValue(
        "assign_provider:square:test:square-account",
        legacy,
        accounts,
      ),
    ).toEqual({
      accountId: "square-account",
      kind: "assign_provider",
      mode: "test",
      provider: "square",
    });
  });

  test("rejects a choice that was not rendered for these facts", () => {
    expect(() =>
      paymentSelectionFromValue(
        "assign_provider:square:test:square-account",
        provenPaymentOperatorCase(),
        [{ accountId: "square-account", mode: "test", provider: "square" }],
      ),
    ).toThrow("This payment decision is not available");
  });
});
