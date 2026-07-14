/**
 * Admin Stripe settings routes - credential configuration, webhook setup and
 * connection test. Owner-only access enforced via defineProviderCredentialsRoute.
 */

import { t } from "#i18n";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import {
  cleanupOldWebhookEndpoints,
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe.ts";

export const stripeRoutes = defineProviderCredentialsRoute<undefined>({
  // Provision the Stripe webhook before the key is persisted, so a setup
  // failure aborts the save leaving nothing configured.
  afterSave: async (value) => {
    const webhookUrl = getPaymentWebhookUrl();
    const result = await setupWebhookEndpoint(
      value,
      webhookUrl,
      settings.stripe.webhookEndpointId,
    );
    if (!result.success) {
      return `Failed to set up Stripe webhook: ${result.error}`;
    }
    // Save the new endpoint ID + secret to the DB FIRST. If this fails, the
    // old endpoint (whose secret matches the DB) stays in place — webhooks
    // keep delivering with the old config instead of losing the only signed
    // endpoint mid-replacement.
    await settings.update.stripe.webhookConfig(result);
    // Now that the new credentials are saved, delete old same-URL endpoints
    // so the new endpoint is the only one pointed at this URL. Cleanup is
    // best-effort: a failure here doesn't unwind the save (the new endpoint
    // is live and the DB points at it).
    await cleanupOldWebhookEndpoints(value, webhookUrl, result.endpointId);
    return null;
  },
  formId: "settings-stripe",
  hasSecret: () => settings.stripe.hasKey,
  logMessage: "Stripe key configured",
  provider: "stripe",
  saveSecret: (value) => settings.update.stripe.secretKey(value),
  secretField: "stripe_secret_key",
  secretRequiredError: t("error.stripe_key_required"),
  successMessage: t("success.stripe_updated"),
  testFn: testStripeConnection,
  unchangedMessage: t("success.stripe_unchanged"),
  validate: (_fields, secret) => {
    if (isDemoMode()) return t("error.stripe_demo_mode");
    if (secret.action === "provided" && !detectStripeKeyMode(secret.value)) {
      return t("error.stripe_key_format");
    }
    return null;
  },
});
