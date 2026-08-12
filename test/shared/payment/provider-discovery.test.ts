import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { readPaymentReferenceEvidence } from "#shared/payment/provider-discovery.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";

type ReadCharge = PaymentProvider["readCharge"];

const chargeMoney = (): ChargeMoney => ({
  captured: { amount: 100, currency: "GBP" },
  confirmedRefunded: { amount: 0, currency: "GBP" },
  refunds: [],
});

const readStub = (
  provider: PaymentProvider,
  answer: ProviderRead<ChargeMoney>,
) =>
  stub(provider, "readCharge", (() => Promise.resolve(answer)) as ReadCharge);

describeWithEnv("payment reference provider evidence", { db: true }, () => {
  test("loads only the named provider for a tagged reference", async () => {
    await settings.update.sumup.apiKey("sumup_tagged");
    await settings.update.stripe.secretKey("sk_test_tagged");
    const charge = chargeMoney();
    using stripeRead = readStub(stripePaymentProvider, {
      resource: charge,
      status: "found",
    });
    using sumupRead = readStub(sumupPaymentProvider, { status: "missing" });

    const answer = await readPaymentReferenceEvidence({
      kind: "tagged",
      provider: "stripe",
      reference: "pi_tagged",
    });

    expect(answer).toMatchObject({
      charge,
      provider: "stripe",
      reference: "pi_tagged",
      source: "tagged",
      status: "found",
    });
    expect(answer.attempts.map(({ provider }) => provider)).toEqual(["stripe"]);
    expect(stripeRead.calls.length).toBe(1);
    expect(sumupRead.calls.length).toBe(0);
  });

  test("does not fall back when a tagged provider has no credentials", async () => {
    await settings.update.sumup.apiKey("sumup_fallback");
    await settings.update.paymentProvider("sumup");
    using stripeRead = readStub(stripePaymentProvider, { status: "missing" });
    using sumupRead = readStub(sumupPaymentProvider, {
      resource: chargeMoney(),
      status: "found",
    });

    expect(
      await readPaymentReferenceEvidence({
        kind: "tagged",
        provider: "stripe",
        reference: "pi_without_credentials",
      }),
    ).toEqual({
      attempts: [],
      provider: "stripe",
      reason: "not_configured",
      reference: "pi_without_credentials",
      source: "tagged",
      status: "unavailable",
    });
    expect(stripeRead.calls.length).toBe(0);
    expect(sumupRead.calls.length).toBe(0);
  });

  test("discovers the one provider whose validated read finds the charge", async () => {
    await settings.update.sumup.apiKey("sumup_discovery");
    await settings.update.paymentProvider("sumup");
    await settings.update.square.accessToken("square_discovery");
    await settings.update.stripe.secretKey("sk_test_discovery");
    const charge = chargeMoney();
    using sumupRead = readStub(sumupPaymentProvider, { status: "missing" });
    using squareRead = readStub(squarePaymentProvider, {
      resource: charge,
      status: "found",
    });
    using stripeRead = readStub(stripePaymentProvider, { status: "missing" });

    const answer = await readPaymentReferenceEvidence({
      kind: "untagged",
      reference: "legacy_reference",
    });

    expect(answer).toMatchObject({
      charge,
      provider: "square",
      reference: "legacy_reference",
      source: "discovered",
      status: "found",
    });
    expect(answer.attempts.map(({ provider }) => provider)).toEqual([
      "sumup",
      "square",
      "stripe",
    ]);
    expect(answer.status === "found" && answer.charge).toBe(charge);
    expect(sumupRead.calls.length).toBe(1);
    expect(squareRead.calls.length).toBe(1);
    expect(stripeRead.calls.length).toBe(1);
  });

  test("keeps an interrupted provider search unresolved", async () => {
    await settings.update.square.accessToken("square_unresolved");
    await settings.update.stripe.secretKey("sk_test_unresolved");
    await settings.update.sumup.apiKey("sumup_unresolved");
    using squareRead = readStub(squarePaymentProvider, { status: "missing" });
    using stripeRead = readStub(stripePaymentProvider, {
      reason: "mismatched_id",
      status: "invalid",
    });
    using sumupRead = readStub(sumupPaymentProvider, {
      reason: "timeout",
      status: "unavailable",
    });

    expect(
      await readPaymentReferenceEvidence({
        kind: "untagged",
        reference: "not_at_any_provider",
      }),
    ).toEqual({
      attempts: [
        { provider: "square", result: { status: "missing" } },
        {
          provider: "stripe",
          result: { reason: "mismatched_id", status: "invalid" },
        },
        {
          provider: "sumup",
          result: { reason: "timeout", status: "unavailable" },
        },
      ],
      reason: "provider_search_incomplete",
      reference: "not_at_any_provider",
      source: "untagged",
      status: "unresolved",
    });
    expect(squareRead.calls.length).toBe(1);
    expect(stripeRead.calls.length).toBe(1);
    expect(sumupRead.calls.length).toBe(1);
  });

  test("does not bind one proof while another provider cannot answer", async () => {
    await settings.update.square.accessToken("square_partial_proof");
    await settings.update.stripe.secretKey("sk_test_partial_proof");
    const charge = chargeMoney();
    using squareRead = readStub(squarePaymentProvider, {
      resource: charge,
      status: "found",
    });
    using stripeRead = readStub(stripePaymentProvider, {
      reason: "timeout",
      status: "unavailable",
    });

    const answer = await readPaymentReferenceEvidence({
      kind: "untagged",
      reference: "incomplete_identity",
    });

    expect(answer).toEqual({
      attempts: [
        { provider: "square", result: { resource: charge, status: "found" } },
        {
          provider: "stripe",
          result: { reason: "timeout", status: "unavailable" },
        },
      ],
      reason: "provider_search_incomplete",
      reference: "incomplete_identity",
      source: "untagged",
      status: "unresolved",
    });
    expect(squareRead.calls.length).toBe(1);
    expect(stripeRead.calls.length).toBe(1);
  });

  test("keeps discovery incomplete when another provider answers invalid", async () => {
    await settings.update.square.accessToken("square_complete_proof");
    await settings.update.stripe.secretKey("sk_test_complete_proof");
    const charge = chargeMoney();
    using squareRead = readStub(squarePaymentProvider, {
      resource: charge,
      status: "found",
    });
    using stripeRead = readStub(stripePaymentProvider, {
      reason: "mismatched_id",
      status: "invalid",
    });

    expect(
      await readPaymentReferenceEvidence({
        kind: "untagged",
        reference: "complete_identity",
      }),
    ).toEqual({
      attempts: [
        { provider: "square", result: { resource: charge, status: "found" } },
        {
          provider: "stripe",
          result: { reason: "mismatched_id", status: "invalid" },
        },
      ],
      reason: "provider_search_incomplete",
      reference: "complete_identity",
      source: "untagged",
      status: "unresolved",
    });
    expect(squareRead.calls.length).toBe(1);
    expect(stripeRead.calls.length).toBe(1);
  });

  test("refuses to choose when more than one provider validates the reference", async () => {
    await settings.update.square.accessToken("square_ambiguous");
    await settings.update.stripe.secretKey("sk_test_ambiguous");
    const charge = chargeMoney();
    using squareRead = readStub(squarePaymentProvider, {
      resource: charge,
      status: "found",
    });
    using stripeRead = readStub(stripePaymentProvider, {
      resource: charge,
      status: "found",
    });

    const answer = await readPaymentReferenceEvidence({
      kind: "untagged",
      reference: "shared_reference",
    });

    expect(answer).toMatchObject({
      reason: "multiple_validating_providers",
      source: "untagged",
      status: "unresolved",
    });
    expect(answer.attempts.map(({ provider }) => provider)).toEqual([
      "square",
      "stripe",
    ]);
    expect(squareRead.calls.length).toBe(1);
    expect(stripeRead.calls.length).toBe(1);
  });

  test("records an empty search when no provider has credentials", async () => {
    expect(
      await readPaymentReferenceEvidence({
        kind: "untagged",
        reference: "unsearchable_reference",
      }),
    ).toEqual({
      attempts: [],
      reason: "no_validating_provider",
      reference: "unsearchable_reference",
      source: "untagged",
      status: "unresolved",
    });
  });

  test("preserves a tagged provider's missing, invalid, and unavailable answers", async () => {
    await settings.update.stripe.secretKey("sk_test_exact_failures");

    for (const result of [
      { status: "missing" },
      { reason: "mismatched_parent", status: "invalid" },
      { reason: "rate_limited", status: "unavailable" },
    ] as const satisfies readonly ProviderRead<ChargeMoney>[]) {
      using read = readStub(stripePaymentProvider, result);
      const answer = await readPaymentReferenceEvidence({
        kind: "tagged",
        provider: "stripe",
        reference: "pi_exact_failure",
      });

      expect(answer).toMatchObject({
        ...result,
        provider: "stripe",
        source: "tagged",
      });
      expect(read.calls.length).toBe(1);
    }
  });
});
