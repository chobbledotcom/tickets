/**
 * Admin Stripe settings routes - credential configuration, webhook setup and
 * connection test. Owner-only access enforced via defineProviderCredentialsRoute.
 */

import { t } from "#i18n";
import {
  defineProviderCredentialsRoute,
  getWebhookUrl,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import {
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe.ts";

const stripeRoutes = defineProviderCredentialsRoute<undefined>({
  // Provision the Stripe webhook before the key is persisted, so a setup
  // failure aborts the save leaving nothing configured.
  afterSave: async (value) => {
    const result = await setupWebhookEndpoint(
      value,
      getWebhookUrl(),
      settings.stripe.webhookEndpointId,
    );
    if (!result.success) {
      return `Failed to set up Stripe webhook: ${result.error}`;
    }
    await settings.update.stripe.webhookConfig(result);
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

/** Handle POST /admin/settings/stripe - owner only */
export const handleAdminStripePost = stripeRoutes.save;

/** Handle POST /admin/settings/stripe/test - owner only */
export const handleStripeTestPost = stripeRoutes.test;
