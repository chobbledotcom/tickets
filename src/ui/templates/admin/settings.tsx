/**
 * Admin settings page template
 */

import { t } from "#i18n";
import type { SuperuserState } from "#shared/superuser.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { BusinessEmailForm } from "#templates/admin/settings/business-email.tsx";
import { CalendarFeedsForm } from "#templates/admin/settings/calendar-feeds.tsx";
import { ChangePasswordForm } from "#templates/admin/settings/change-password.tsx";
import { CountryForm } from "#templates/admin/settings/country.tsx";
import { EmbedHostsForm } from "#templates/admin/settings/embed-hosts.tsx";
import { HeaderImageForm } from "#templates/admin/settings/header-image.tsx";
import {
  BookingFeeForm,
  PaymentProviderForm,
  SquareForm,
  SquareWebhookForm,
  StripeForm,
  SumUpForm,
} from "#templates/admin/settings/payment.tsx";
import { PublicSiteForm } from "#templates/admin/settings/public-site.tsx";
import { SuperuserForm } from "#templates/admin/settings/superuser.tsx";
import { TermsForm } from "#templates/admin/settings/terms.tsx";
import { ThemeForm } from "#templates/admin/settings/theme.tsx";
import { Layout } from "#templates/layout.tsx";

export type SettingsPageState = {
  stripeKeyConfigured: boolean;
  stripeKeyMode: string | null;
  paymentProvider: string;
  squareTokenConfigured: boolean;
  squareSandbox: boolean;
  squareWebhookConfigured: boolean;
  sumupKeyConfigured: boolean;
  sumupKeyMode: string | null;
  webhookUrl: string;
  bookingFee: string;
  embedHosts: string;
  termsAndConditions: string;
  businessEmail: string;
  theme: Theme;
  showPublicSite: boolean;
  country: string;
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
 * 1. Country - fundamental (sets currency, timezone)
 * 2. Business Email - basic setup
 * 3. Header Image - branding
 * 4. Site Theme - appearance
 * 5. Show Public Site - appearance
 * 6. Payment Provider + Stripe/Square/Webhook/Booking Fee
 * 7. Terms and Conditions
 * 8. Embed Hosts - niche
 * 9. Change Password - rare maintenance
 * 10. Calendar Feeds - niche read-only feed
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  String(
    <Layout theme={s.theme} title={t("settings.title")}>
      <AdminNav active="/admin/settings" session={session}>
        <SettingsSubNav />
      </AdminNav>
      {CountryForm(s)}
      {BusinessEmailForm(s)}
      {HeaderImageForm(s)}
      {ThemeForm(s)}
      {PublicSiteForm(s)}

      {PaymentProviderForm(s)}
      {StripeForm(s)}
      {SquareForm(s)}
      {SquareWebhookForm(s)}
      {SumUpForm(s)}
      {BookingFeeForm(s)}

      {TermsForm(s)}
      {EmbedHostsForm(s)}
      <SuperuserForm superuser={s.superuser} />
      <ChangePasswordForm />
      {CalendarFeedsForm(s)}
    </Layout>,
  );
