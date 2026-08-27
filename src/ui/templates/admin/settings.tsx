/**
 * Admin settings page template
 */

import { t } from "#i18n";
import type { EnabledFeatures } from "#shared/admin-features.ts";
import type { PaymentProviderMode } from "#shared/payment-provider-status.ts";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import type { SuperuserState } from "#shared/superuser.ts";
import { FeaturesTable } from "#templates/admin/features.tsx";
import { ChangePasswordForm } from "#templates/admin/settings/change-password.tsx";
import { HeaderImageForm } from "#templates/admin/settings/header-image.tsx";
import { settingsPage } from "#templates/admin/settings/page-shell.tsx";
import {
  PaymentProviderForm,
  ProviderCredentialsForm,
  SquareWebhookForm,
} from "#templates/admin/settings/payment.tsx";
import { ExistingPaymentProviderForm } from "#templates/admin/settings/payment-provider.tsx";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { SuperuserForm } from "#templates/admin/settings/superuser.tsx";
import type { AdminSession, PaymentProviderType, Theme } from "#types";

/** The provider whose credentials form the page shows — the one taking new
 *  sales, or the one that owns the payments already taken — and what the
 *  site's stored credentials for it say. */
export type ShownPaymentProvider = {
  /** Whether the credentials this provider needs are stored. */
  readonly configured: boolean;
  /** Which of the provider's estates those credentials point at. */
  readonly mode: PaymentProviderMode;
  readonly provider: PaymentProviderType;
};

export type SettingsPageState = {
  paymentProvider: PaymentProviderType | null;
  paymentProviderRecoveryChoices: PaymentProviderType[];
  shownPaymentProvider: ShownPaymentProvider | null;
  /** The site's ISO currency code — decides which providers can be picked. */
  currency: string;
  squareWebhookConfigured: boolean;
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
 * Admin settings page. The forms run from most to least commonly configured, so
 * a new form goes in by how often an operator touches it.
 *
 * Country and locale are deliberately absent. They are set once during /setup
 * and are write-once after that, so only an edit to the database changes them.
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
      {ProviderCredentialsForm(s)}
      {SquareWebhookForm(s)}
      {s.paymentProvider ? settingsForm(SETTINGS_FORMS.bookingFee, s) : null}

      {settingsForm(SETTINGS_FORMS.terms, s)}
      {settingsForm(SETTINGS_FORMS.embedHosts, s)}
      <SuperuserForm superuser={s.superuser} />
      <ChangePasswordForm />
      {settingsForm(SETTINGS_FORMS.calendarFeeds, s)}
      <FeaturesTable enabledFeatures={s.enabledFeatures} />
    </>,
  );
