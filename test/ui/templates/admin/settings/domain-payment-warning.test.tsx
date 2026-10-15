import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";
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
    assertStringIncludes(html, "Choose the provider for existing payments");
    assertStringIncludes(html, "</strong> <a");
    assertStringIncludes(
      html,
      'href="/admin/settings#settings-payment-provider-recovery"',
    );
  });

  test("links Square users to their webhook settings", () => {
    const html = renderWarning("square");

    assertStringIncludes(
      html,
      "<strong>Changing your domain changes your payment webhook URL.</strong> Your payment provider",
    );
    assertStringIncludes(
      html,
      'href="/admin/settings#settings-square-webhook"',
    );
    assert(
      !html.includes('href="/admin/settings#settings-stripe"'),
      "the value should not contain the searched item",
    );
  });

  test("links Stripe users to their webhook settings", () => {
    const html = renderWarning("stripe");

    assertStringIncludes(
      html,
      "Changing your domain changes your payment webhook",
    );
    assertStringIncludes(html, 'href="/admin/settings#settings-stripe"');
    assert(
      !html.includes('href="/admin/settings#settings-square-webhook"'),
      "the value should not contain the searched item",
    );
  });
});
