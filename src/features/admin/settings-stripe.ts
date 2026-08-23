/**
 * Admin Stripe settings routes - credential configuration, webhook setup and
 * connection test. Owner-only access enforced via defineProviderCredentialsRoute.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-provider-credentials.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import { detectStripeKeyMode, stripeApi } from "#shared/stripe.ts";

export const stripeRoutes = defineProviderCredentialsRoute<undefined>({
  formId: "settings-stripe",
  hasSecret: () => settings.stripe.hasKey,
  logMessage: "Stripe key configured",
  provider: "stripe",
  saveSecret: async (value) => {
    const webhookUrl = getPaymentWebhookUrl();
    const previousSecretKey = settings.stripe.secretKey;
    const previousEndpointId = settings.stripe.webhookEndpointId;
    const keyChanged = previousSecretKey !== value;
    // Always pass the recorded endpoint id. If the new key is on the same
    // Stripe account, setup's limit-retry path keeps it live until the new
    // endpoint has been created and saved; the cleanup calls below remove it
    // once the replacement is in place. Passing undefined on a key rotation
    // would let the retry delete the live webhook before a replacement exists.
    const result = await stripeApi.setupWebhookEndpoint(
      value,
      webhookUrl,
      previousEndpointId,
    );
    if (!result.success) {
      return `Failed to set up Stripe webhook: ${result.error}`;
    }
    await settings.update.stripe.configure({
      secretKey: value,
      webhookEndpointId: result.endpointId,
      webhookSecret: result.secret,
    });
    // Cleanup can fail after the replacement is safely stored; surface it so
    // stale provider state remains visible.
    if (keyChanged && previousSecretKey && previousEndpointId) {
      await stripeApi.cleanupOldWebhookEndpoints(
        previousSecretKey,
        null,
        null,
        [previousEndpointId],
      );
    }
    await stripeApi.cleanupOldWebhookEndpoints(
      value,
      webhookUrl,
      result.endpointId,
      !keyChanged && previousEndpointId ? [previousEndpointId] : [],
    );
    return null;
  },
  secretField: "stripe_secret_key",
  secretRequiredError: t("error.stripe_key_required"),
  successMessage: t("success.stripe_updated"),
  testFn: () => stripeApi.testStripeConnection(),
  unchangedMessage: t("success.stripe_unchanged"),
  validate: (_fields, secret) => {
    if (isDemoMode()) return t("error.stripe_demo_mode");
    if (secret.action === "provided" && !detectStripeKeyMode(secret.value)) {
      return t("error.stripe_key_format");
    }
    return null;
  },
});
