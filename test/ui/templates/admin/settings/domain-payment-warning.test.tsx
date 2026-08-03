import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";

const renderWarning = (paymentProvider: string): string =>
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
    expect(html).toContain("Choose the provider for existing payments");
    expect(html).toContain("</strong> <a");
    expect(html).toContain(
      'href="/admin/settings#settings-payment-provider-recovery"',
    );
  });

  test("links Square users to their webhook settings", () => {
    const html = renderWarning("square");

    expect(html).toContain(
      "<strong>Changing your domain changes your payment webhook URL.</strong> Your payment provider",
    );
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
    expect(html).not.toContain('href="/admin/settings#settings-stripe"');
  });

  test("links Stripe users to their webhook settings", () => {
    const html = renderWarning("stripe");

    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
    expect(html).not.toContain(
      'href="/admin/settings#settings-square-webhook"',
    );
  });
});
