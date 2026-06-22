/**
 * Admin settings page template
 */

import { t } from "#i18n";
import type { SuperuserState } from "#shared/superuser.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { BusinessEmailForm } from "#templates/admin/settings/business-email.tsx";
import { CalendarFeedsForm } from "#templates/admin/settings/calendar-feeds.tsx";
import { ChangePasswordForm } from "#templates/admin/settings/change-password.tsx";
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
 * 4. Show Public Site - appearance
 * 5. Payment Provider + Stripe/Square/Webhook/Booking Fee
 * 6. Terms and Conditions
 * 7. Embed Hosts - niche
 * 8. Change Password - rare maintenance
 * 9. Calendar Feeds - niche read-only feed
 *
 * Country/locale is intentionally absent: it is set once during /setup and is
 * write-once thereafter (only an admin editing the database can change it).
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  String(
    <Layout theme={s.theme} title={t("settings.title")}>
      <AdminNav active="/admin/settings" session={session} />
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
