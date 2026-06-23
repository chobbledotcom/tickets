/**
 * Admin SumUp settings routes - credential configuration and connection test
 * Owner-only access enforced via settingsHandler / testRoute
 */

import {
  processSecretField,
  type SecretFieldResult,
  settingsHandler,
  testRoute,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import { isSumupCurrency, testSumupConnection } from "#shared/sumup.ts";

/**
 * Handle POST /admin/settings/sumup - owner only
 */
type SumupFormData = {
  apiKey: SecretFieldResult;
  merchantCode: string;
};

export const handleAdminSumupPost = settingsHandler<SumupFormData>({
  extract: (form) => ({
    apiKey: processSecretField(form, "sumup_api_key"),
    merchantCode: form.getString("sumup_merchant_code"),
  }),
  formId: "settings-sumup",
  label: "SumUp credentials",
  save: async ({ apiKey, merchantCode }) => {
    if (apiKey.action === "provided") {
      await settings.update.sumup.apiKey(apiKey.value);
    }
    await settings.update.sumup.merchantCode(merchantCode);
    await settings.update.paymentProvider("sumup");
  },
  validate: ({ apiKey, merchantCode }) => {
    if (isDemoMode()) return "Cannot configure SumUp in demo mode";
    if (!isSumupCurrency(settings.currency)) {
      return `SumUp does not support your site currency (${settings.currency}). Choose a different payment provider.`;
    }
    if (!merchantCode) return "Merchant code is required";
    if (apiKey.action === "cleared" && !settings.sumup.hasKey) {
      return "SumUp API Key is required";
    }
    return null;
  },
});

/** Handle POST /admin/settings/sumup/test - owner only */
export const handleSumupTestPost = testRoute(testSumupConnection);
