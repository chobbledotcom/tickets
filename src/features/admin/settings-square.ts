/**
 * Admin Square settings routes - credentials, webhook signature key and
 * connection test. Owner-only access enforced via
 * defineProviderCredentialsRoute / settingsSecret.
 */

import { t } from "#i18n";
import {
  defineProviderCredentialsRoute,
  settingsSecret,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import { testSquareConnection } from "#shared/square.ts";
import {
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

type SquareFields = {
  locationId: string;
  sandbox: boolean;
};

const squareRoutes = defineProviderCredentialsRoute<SquareFields>({
  extraFields: (form) => ({
    locationId: form.getString("square_location_id"),
    sandbox: form.get("square_sandbox") === "on",
  }),
  formId: "settings-square",
  hasSecret: () => settings.square.hasToken,
  logMessage: "Square credentials updated",
  provider: "square",
  saveFields: async ({ locationId, sandbox }) => {
    await settings.update.square.locationId(locationId);
    await settings.update.square.sandbox(sandbox);
  },
  saveSecret: (value) => settings.update.square.accessToken(value),
  secretField: "square_access_token",
  secretRequiredError: t("error.square_token_required"),
  successMessage: "Square credentials updated",
  testFn: testSquareConnection,
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

/** Handle POST /admin/settings/square - owner only */
export const handleAdminSquarePost = squareRoutes.save;

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
export const handleAdminSquareWebhookPost = settingsSecret({
  field: "square_webhook_signature_key",
  formId: "settings-square-webhook",
  label: "Square webhook signature key",
  required: true,
  save: (v) => settings.update.square.webhookSignatureKey(v),
  validate: validateSquareWebhookSignatureKey,
});

/** Handle POST /admin/settings/square/test - owner only */
export const handleSquareTestPost = squareRoutes.test;
