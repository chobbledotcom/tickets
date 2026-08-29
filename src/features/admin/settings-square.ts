/**
 * Admin Square settings routes - credentials, webhook signature key and
 * connection test. Owner-only access enforced via
 * defineProviderCredentialsRoute / settingsSecret.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { squareConnectionAnswer } from "#routes/admin/settings-connection-lines.ts";
/* jscpd:ignore-start */
import { settingsSecret } from "#routes/admin/settings-helpers.ts";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-provider-credentials.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { squareApi } from "#shared/square/api.ts";
/* jscpd:ignore-end */
import {
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

type SquareFields = {
  locationId: string;
  sandbox: boolean;
};

export const squareRoutes = defineProviderCredentialsRoute<SquareFields>({
  extraFields: (form) => ({
    locationId: form.getString("square_location_id"),
    sandbox: form.get("square_sandbox") === "on",
  }),
  logMessage: "Square credentials updated",
  provider: "square",
  saveFields: async ({ locationId, sandbox }) => {
    await settings.update.square.locationId(locationId);
    await settings.update.square.sandbox(sandbox);
  },
  saveSecret: (value) => settings.update.square.accessToken(value),
  secretRequiredError: t("error.square_token_required"),
  successMessage: "Square credentials updated",
  // A lambda, not the member itself: the config is built once at module
  // load, and resolving the member per call keeps test stubs live.
  testFn: async () =>
    squareConnectionAnswer(await squareApi.testSquareConnection()),
  validate: ({ locationId }, secret) => {
    if (isDemoMode()) return t("error.square_demo_mode");
    if (!locationId) return t("error.square_location_required");
    const locationError = validateSquareLocationId(locationId);
    if (locationError) return locationError;
    if (secret.action === "provided") {
      return validateSquareAccessToken(secret.value);
    }
    return null;
  },
});

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
export const handleAdminSquareWebhookPost = settingsSecret({
  field: "square_webhook_signature_key",
  formId: "settings-square-webhook",
  label: "Square webhook signature key",
  save: (v) => settings.update.square.webhookSignatureKey(v),
  validate: validateSquareWebhookSignatureKey,
});
