/**
 * Admin Square settings routes - credentials, webhook signature key and
 * connection test. Owner-only access enforced via settingsHandler /
 * settingsSecret / testRoute.
 */

/* jscpd:ignore-start */
import {
  processSecretField,
  type SecretFieldResult,
  settingsHandler,
  settingsSecret,
  testRoute,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import { testSquareConnection } from "#shared/square.ts";
import {
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

/* jscpd:ignore-end */

/**
 * Handle POST /admin/settings/square - owner only
 */
type SquareFormData = {
  token: SecretFieldResult;
  locationId: string;
  sandbox: boolean;
};

export const handleAdminSquarePost = settingsHandler<SquareFormData>({
  extract: (form) => ({
    locationId: form.getString("square_location_id"),
    sandbox: form.get("square_sandbox") === "on",
    token: processSecretField(form, "square_access_token"),
  }),
  formId: "settings-square",
  label: "Square credentials",
  save: async ({ token, locationId, sandbox }) => {
    if (token.action === "provided") {
      await settings.update.square.accessToken(token.value);
    }
    await settings.update.square.locationId(locationId);
    await settings.update.square.sandbox(sandbox);
    await settings.update.paymentProvider("square");
  },
  validate: ({ token, locationId }) => {
    if (isDemoMode()) return "Cannot configure Square in demo mode";
    if (!locationId) return "Location ID is required";
    const locationError = validateSquareLocationId(locationId);
    if (locationError) return locationError;
    if (token.action === "cleared" && !settings.square.hasToken) {
      return "Square Access Token is required";
    }
    if (token.action === "provided") {
      const tokenError = validateSquareAccessToken(token.value);
      if (tokenError) return tokenError;
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
  required: true,
  save: (v) => settings.update.square.webhookSignatureKey(v),
  validate: validateSquareWebhookSignatureKey,
});

/** Handle POST /admin/settings/square/test - owner only */
export const handleSquareTestPost = testRoute(testSquareConnection);
