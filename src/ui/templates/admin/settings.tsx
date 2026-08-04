/**
 * Admin settings page template
 */

import { t } from "#i18n";
import type { EnabledFeatures } from "#shared/admin-features.ts";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import type { SuperuserState } from "#shared/superuser.ts";
import type {
  AdminSession,
  PaymentProviderType,
  Theme,
} from "#shared/types.ts";
import { FeaturesTable } from "#templates/admin/features.tsx";
import { ChangePasswordForm } from "#templates/admin/settings/change-password.tsx";
import { HeaderImageForm } from "#templates/admin/settings/header-image.tsx";
import { settingsPage } from "#templates/admin/settings/page-shell.tsx";
import {
  PaymentProviderForm,
  SquareForm,
  SquareWebhookForm,
  StripeForm,
  SumUpForm,
} from "#templates/admin/settings/payment.tsx";
import { ExistingPaymentProviderForm } from "#templates/admin/settings/payment-provider.tsx";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { SuperuserForm } from "#templates/admin/settings/superuser.tsx";

export type SettingsPageState = {
  stripeKeyConfigured: boolean;
  stripeKeyMode: string | null;
  paymentProvider: PaymentProviderType | null;
  existingPaymentProvider: PaymentProviderType | null;
  paymentProviderRecoveryChoices: PaymentProviderType[];
  /** The site's ISO currency code — decides which providers can be picked. */
  currency: string;
  squareTokenConfigured: boolean;
  squareSandbox: boolean;
  squareWebhookConfigured: boolean;
  sumupKeyConfigured: boolean;
  sumupKeyMode: string | null;
  webhookUrl: string;
  bookingFee: string;
  embedHosts: string;
  enabledFeatures: EnabledFeatures;
  termsAndConditions: string;
  businessEmail: string;
  theme: Theme;
  underlineLinks: boolean;
  headerImageUrl: string;
  storageEnabled: boolean;
  superuser: SuperuserState;
  calendarFeedsEnabled: boolean;
  calendarFeedsGroupBy: "attendees" | "listings";
};

/**
 * Admin settings page
 *
 * Forms ordered from most to least commonly configured:
 * 1. Business Email - basic setup
 * 2. Header Image - branding
 * 3. Site Theme - appearance
 * 4. Payment Provider + Stripe/Square/Webhook/Booking Fee
 * 5. Terms and Conditions
 * 6. Embed Hosts - niche
 * 7. Change Password - rare maintenance
 * 8. Calendar Feeds - niche read-only feed
 *
 * Country/locale is intentionally absent: it is set once during /setup and is
 * write-once thereafter (only an admin editing the database can change it).
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  settingsPage(t("settings.title"))(session, s.theme)(
    <>
      {settingsForm(SETTINGS_FORMS.businessEmail, s)}
      {HeaderImageForm(s)}
      {settingsForm(SETTINGS_FORMS.theme, s)}

      {PaymentProviderForm(s)}
      {ExistingPaymentProviderForm(s)}
      {StripeForm(s)}
      {SquareForm(s)}
      {SquareWebhookForm(s)}
      {SumUpForm(s)}
      {s.paymentProvider ? settingsForm(SETTINGS_FORMS.bookingFee, s) : null}

      {settingsForm(SETTINGS_FORMS.terms, s)}
      {settingsForm(SETTINGS_FORMS.embedHosts, s)}
      <SuperuserForm superuser={s.superuser} />
      <ChangePasswordForm />
      {settingsForm(SETTINGS_FORMS.calendarFeeds, s)}
      <FeaturesTable enabledFeatures={s.enabledFeatures} />
    </>,
  );
