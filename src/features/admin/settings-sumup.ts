/**
 * Admin SumUp settings routes - credential configuration and connection test
 * Owner-only access enforced via defineProviderCredentialsRoute
 */

import { settings } from "#db/settings.ts";
/* jscpd:ignore-start */
import { defineProviderCredentialsRoute } from "#routes/admin/settings-provider-credentials.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { providerCurrencyBlock } from "#shared/payment-providers.ts";
import { sumupApi } from "#shared/sumup.ts";

/* jscpd:ignore-end */

type SumupFields = {
  merchantCode: string;
};

export const sumupRoutes = defineProviderCredentialsRoute<SumupFields>({
  extraFields: (form) => ({
    merchantCode: form.getString("sumup_merchant_code"),
  }),
  logMessage: "SumUp credentials updated",
  provider: "sumup",
  saveFields: ({ merchantCode }) =>
    settings.update.sumup.merchantCode(merchantCode),
  saveSecret: (value) => settings.update.sumup.apiKey(value),
  secretRequiredError: "SumUp API Key is required",
  successMessage: "SumUp credentials updated",
  // A lambda, not the member itself: the config is built once at module
  // load, and resolving the member per call keeps test stubs live.
  testFn: () => sumupApi.testSumupConnection(),
  validate: ({ merchantCode }) => {
    if (isDemoMode()) return "Cannot configure SumUp in demo mode";
    const currencyBlock = providerCurrencyBlock("sumup", settings.currency);
    if (currencyBlock) return currencyBlock;
    if (!merchantCode) return "Merchant code is required";
    return null;
  },
});
