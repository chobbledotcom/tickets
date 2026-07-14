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
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe.ts";
import { STRIPE_WEBHOOK_EVENTS_VERSION } from "#shared/stripe-webhook-events.ts";

export const stripeRoutes = defineProviderCredentialsRoute<undefined>({
  // Provision the Stripe webhook before the key is persisted, so a setup
  // failure aborts the save leaving nothing configured.
  afterSave: async (value) => {
    const result = await setupWebhookEndpoint(
      value,
      getPaymentWebhookUrl(),
      settings.stripe.webhookEndpointId,
    );
    if (!result.success) {
      return `Failed to set up Stripe webhook: ${result.error}`;
    }
    await settings.update.stripe.webhookConfig(result);
    await settings.update.stripe.webhookEventsVersion(
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
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
