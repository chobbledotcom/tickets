/**
 * Admin SumUp settings routes - credential configuration and connection test
 * Owner-only access enforced via defineProviderCredentialsRoute
 */

/* jscpd:ignore-start */
import { defineProviderCredentialsRoute } from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { isSumupCurrency, sumupApi } from "#shared/sumup.ts";

/* jscpd:ignore-end */

type SumupFields = {
  merchantCode: string;
};

export const sumupRoutes = defineProviderCredentialsRoute<SumupFields>({
  extraFields: (form) => ({
    merchantCode: form.getString("sumup_merchant_code"),
  }),
  formId: "settings-sumup",
  hasSecret: () => settings.sumup.hasKey,
  logMessage: "SumUp credentials updated",
  provider: "sumup",
  saveFields: ({ merchantCode }) =>
    settings.update.sumup.merchantCode(merchantCode),
  saveSecret: (value) => settings.update.sumup.apiKey(value),
  secretField: "sumup_api_key",
  secretRequiredError: "SumUp API Key is required",
  successMessage: "SumUp credentials updated",
  testFn: () => sumupApi.testSumupConnection(),
  validate: ({ merchantCode }) => {
    if (isDemoMode()) return "Cannot configure SumUp in demo mode";
    if (!isSumupCurrency(settings.currency)) {
      return `SumUp does not support your site currency (${settings.currency}). Choose a different payment provider.`;
    }
    if (!merchantCode) return "Merchant code is required";
    return null;
  },
});
