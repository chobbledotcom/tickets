/**
 * Admin Stripe settings routes - credential configuration, webhook setup and
 * connection test. Owner-only access enforced via settingsRoute / testRoute.
 */

import { t } from "#i18n";
import {
  getWebhookUrl,
  processSecretField,
  settingsRoute,
  testRoute,
} from "#routes/admin/settings-helpers.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import { ok } from "#shared/response.ts";
import {
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe.ts";

/**
 * Handle POST /admin/settings/stripe - owner only
 */
export const handleAdminStripePost = settingsRoute(async (form, errorPage) => {
  if (isDemoMode()) {
    return errorPage(t("error.stripe_demo_mode"), 400, "settings-stripe");
  }

  const field = processSecretField(form, "stripe_secret_key");

  if (field.action === "unchanged") {
    return ok("/admin/settings", t("success.stripe_unchanged"), {
      formId: "settings-stripe",
    });
  }

  if (field.action === "cleared") {
    if (!settings.stripe.hasKey) {
      return errorPage(t("error.stripe_key_required"), 400, "settings-stripe");
    }
    return ok("/admin/settings", t("success.stripe_unchanged"), {
      formId: "settings-stripe",
    });
  }

  if (!detectStripeKeyMode(field.value)) {
    return errorPage(t("error.stripe_key_format"), 400, "settings-stripe");
  }

  const webhookUrl = getWebhookUrl();
  const webhookResult = await setupWebhookEndpoint(
    field.value,
    webhookUrl,
    settings.stripe.webhookEndpointId,
  );

  if (!webhookResult.success) {
    return errorPage(
      `Failed to set up Stripe webhook: ${webhookResult.error}`,
      400,
      "settings-stripe",
    );
  }

  await settings.update.stripe.secretKey(field.value);
  await settings.update.stripe.webhookConfig(webhookResult);
  await settings.update.paymentProvider("stripe");

  await logActivity("Stripe key configured");
  return ok("/admin/settings", t("success.stripe_updated"), {
    formId: "settings-stripe",
  });
});

/** Handle POST /admin/settings/stripe/test - owner only */
export const handleStripeTestPost = testRoute(testStripeConnection);
