import { parseEnabledFeatures } from "#shared/admin-features.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

const DEFAULT_ENABLED_FEATURES = parseEnabledFeatures("");

export const defaultSettingsState = (): SettingsPageState => ({
  bookingFee: "0",
  businessEmail: "",
  calendarFeedsEnabled: false,
  calendarFeedsGroupBy: "attendees",
  currency: "GBP",
  embedHosts: "",
  enabledFeatures: DEFAULT_ENABLED_FEATURES,
  expectedTax: '{"mode":"none"}',
  headerImageUrl: "",
  paymentProvider: null,
  paymentProviderRecoveryChoices: [],
  shownPaymentProvider: null,
  siteFooter: "",
  squareWebhookConfigured: false,
  storageEnabled: false,
  superuser: { available: false, reason: "missing-env" },
  taxMode: "none",
  taxRate: "",
  termsAndConditions: "",
  theme: "light",
  underlineLinks: false,
  webhookUrl: "https://example.com/payment/webhook",
});
