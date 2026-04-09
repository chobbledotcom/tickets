/**
 * Admin settings page template
 */

import type { AdminSession, Theme } from "#lib/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { BusinessEmailForm } from "#templates/admin/settings/business-email.tsx";
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
} from "#templates/admin/settings/payment.tsx";
import { PublicSiteForm } from "#templates/admin/settings/public-site.tsx";
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
 */
export const adminSettingsPage = (
  session: AdminSession,
  s: SettingsPageState,
): string =>
  String(
    <Layout title="Settings" theme={s.theme}>
      <AdminNav session={session} active="/admin/settings" />
      <SettingsSubNav />

      {CountryForm(s)}
      {BusinessEmailForm(s)}
      {HeaderImageForm(s)}
      {ThemeForm(s)}
      {PublicSiteForm(s)}

      {PaymentProviderForm(s)}
      {StripeForm(s)}
      {SquareForm(s)}
      {SquareWebhookForm(s)}
      {BookingFeeForm(s)}

      {TermsForm(s)}
      {EmbedHostsForm(s)}
      <ChangePasswordForm />
    </Layout>,
  );
