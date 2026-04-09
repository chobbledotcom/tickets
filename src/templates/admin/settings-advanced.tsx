/**
 * Admin advanced settings page template
 */

import type { AdminSession, Theme } from "#lib/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { AppleWalletForm } from "#templates/admin/settings-advanced-apple-wallet.tsx";
import { CustomDomainForm } from "#templates/admin/settings-advanced-custom-domain.tsx";
import { EmailNotificationsForm } from "#templates/admin/settings-advanced-email.tsx";
import { AdminEmailTemplateForm } from "#templates/admin/settings-advanced-email-tpl-admin.tsx";
import { ConfirmationEmailTemplateForm } from "#templates/admin/settings-advanced-email-tpl-confirmation.tsx";
import { GoogleWalletForm } from "#templates/admin/settings-advanced-google-wallet.tsx";
import { PublicApiForm } from "#templates/admin/settings-advanced-public-api.tsx";
import { SoftwareUpdatesSection } from "#templates/admin/settings-advanced-software-updates.tsx";
import { HostSubdomainForm } from "#templates/admin/settings-advanced-subdomain.tsx";
import { Layout } from "#templates/layout.tsx";

export type AdvancedSettingsPageState = {
  showPublicApi: boolean;
  emailProvider: string;
  emailApiKeyConfigured: boolean;
  emailFromAddress: string;
  hostEmailLabel: string;
  businessEmail: string;
  confirmationTemplates: {
    subject: string;
    html: string;
    text: string;
  };
  adminTemplates: {
    subject: string;
    html: string;
    text: string;
  };
  bunnyCdnEnabled: boolean;
  bunnyDnsEnabled: boolean;
  bunnySubdomain: string;
  bunnyDnsSubdomainSuffix: string;
  subdomainPreview: string;
  subdomainPreviewFullDomain: string;
  customDomain: string;
  customDomainLastValidated: string;
  cdnHostname: string;
  appleWalletConfigured: boolean;
  appleWalletPassTypeId: string;
  appleWalletTeamId: string;
  hostAppleWalletLabel: string;
  googleWalletConfigured: boolean;
  googleWalletIssuerId: string;
  googleWalletServiceAccountEmail: string;
  hostGoogleWalletLabel: string;
  theme: Theme;
};

/**
 * Admin advanced settings page
 *
 * Forms ordered from most to least likely to be configured:
 * 1. Email Notifications - most users want confirmation emails
 * 2. Host Subdomain - easy pretty URL
 * 3. Custom Domain - common for own-domain users
 * 4. Confirmation Email Template - customising emails
 * 5. Admin Notification Email Template
 * 6. Public API - for integrations
 * 7. Google Wallet - less common
 * 8. Apple Wallet - requires Apple Developer account
 * 9. Software Updates
 * 10. Reset Database - destructive, always last
 */
export const adminAdvancedSettingsPage = (
  session: AdminSession,
  s: AdvancedSettingsPageState,
): string =>
  String(
    <Layout title="Advanced Settings" theme={s.theme}>
      <AdminNav session={session} active="/admin/settings" />
      <SettingsSubNav />

      <article>
        <aside>
          <p>
            Be careful changing settings on this page. You can break your site
            in ways that can be hard to diagnose. Test your booking process
            after making a change.
          </p>
        </aside>
      </article>

      {EmailNotificationsForm(s)}
      {HostSubdomainForm(s)}
      {CustomDomainForm(s)}
      {ConfirmationEmailTemplateForm(s)}
      {AdminEmailTemplateForm(s)}
      {PublicApiForm(s)}
      {GoogleWalletForm(s)}
      {AppleWalletForm(s)}
      <SoftwareUpdatesSection />

      <ResetDatabaseForm
        action="/admin/settings/reset-database"
        id="settings-reset-database"
      />
    </Layout>,
  );
