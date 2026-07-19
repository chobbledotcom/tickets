/**
 * Admin Stripe settings routes - credential configuration, webhook setup and
 * connection test. Owner-only access enforced via defineProviderCredentialsRoute.
 */

import { t } from "#i18n";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
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
    const previousEndpointId = settings.stripe.webhookEndpointId;
    const result = await stripeApi.setupWebhookEndpoint(
      value,
      webhookUrl,
      previousEndpointId,
    );
    if (!result.success) {
      return `Failed to set up Stripe webhook: ${result.error}`;
    }
    await settings.update.stripe.activate({
      secretKey: value,
      webhookEndpointId: result.endpointId,
      webhookSecret: result.secret,
    });
    // Cleanup can now fail without leaving saved credentials that name a
    // deleted endpoint or leaving Stripe unselected. The error still propagates
    // so stale state is visible.
    await stripeApi.cleanupOldWebhookEndpoints(
      value,
      webhookUrl,
      result.endpointId,
      previousEndpointId ? [previousEndpointId] : [],
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
