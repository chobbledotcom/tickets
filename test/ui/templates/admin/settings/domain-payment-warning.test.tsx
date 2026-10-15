import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";
import { says } from "#test-utils/says.ts";
import type { PaymentProviderType } from "#types";

const renderWarning = (paymentProvider: PaymentProviderType): string =>
  String(
    DomainPaymentWebhookWarning({
      existingPaymentProvider: paymentProvider,
      paymentProviderRecoveryNeeded: false,
    }),
  );

describe("domain payment webhook warning", () => {
  test("is hidden when the provider has no webhook", () => {
    expect(
      DomainPaymentWebhookWarning({
        existingPaymentProvider: null,
        paymentProviderRecoveryNeeded: false,
      }),
    ).toBeNull();
    expect(
      DomainPaymentWebhookWarning({
        existingPaymentProvider: "sumup",
        paymentProviderRecoveryNeeded: false,
      }),
    ).toBeNull();
  });

  test("links to provider recovery before a domain change", () => {
    const html = String(
      DomainPaymentWebhookWarning({
        existingPaymentProvider: null,
        paymentProviderRecoveryNeeded: true,
      }),
    );
    says(html, "Choose the provider for existing payments");
    says(html, "</strong> <a");
    says(html, 'href="/admin/settings#settings-payment-provider-recovery"');
  });

  test("links Square users to their webhook settings", () => {
    const html = renderWarning("square");

    says(
      html,
      "<strong>Changing your domain changes your payment webhook URL.</strong> Your payment provider",
    );
    says(html, 'href="/admin/settings#settings-square-webhook"');
    assert(!html.includes('href="/admin/settings#settings-stripe"'));
  });

  test("links Stripe users to their webhook settings", () => {
    const html = renderWarning("stripe");

    says(html, "Changing your domain changes your payment webhook");
    says(html, 'href="/admin/settings#settings-stripe"');
    assert(!html.includes('href="/admin/settings#settings-square-webhook"'));
  });
});
