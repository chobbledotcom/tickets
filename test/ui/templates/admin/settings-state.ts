import { parseEnabledFeatures } from "#shared/admin-features.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const TEST_SETTINGS_SESSION = { adminLevel: "owner" as const };

export const defaultSettingsState = (): SettingsPageState => ({
  bookingFee: "0",
  businessEmail: "",
  calendarFeedsEnabled: false,
  calendarFeedsGroupBy: "attendees",
  embedHosts: "",
  enabledFeatures: parseEnabledFeatures(""),
  headerImageUrl: "",
  paymentProvider: "",
  squareSandbox: false,
  squareTokenConfigured: false,
  squareWebhookConfigured: false,
  storageEnabled: false,
  stripeKeyConfigured: false,
  stripeKeyMode: null,
  sumupKeyConfigured: false,
  sumupKeyMode: null,
  superuser: { available: false, reason: "missing-env" },
  termsAndConditions: "",
  theme: "light",
  underlineLinks: false,
  webhookUrl: "https://example.com/payment/webhook",
});
