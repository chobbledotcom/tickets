/**
 * Admin advanced settings page template
 */

import { t } from "#i18n";
import type { AdminSession, Theme } from "#shared/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { AppleWalletForm } from "#templates/admin/settings/apple-wallet.tsx";
import {
  AttendeeColumnOrderForm,
  ListingColumnOrderForm,
} from "#templates/admin/settings/column-order.tsx";
import { CustomDomainForm } from "#templates/admin/settings/custom-domain.tsx";
import { EmailNotificationsForm } from "#templates/admin/settings/email.tsx";
import { AdminEmailTemplateForm } from "#templates/admin/settings/email-tpl-admin.tsx";
import { ConfirmationEmailTemplateForm } from "#templates/admin/settings/email-tpl-confirmation.tsx";
import { GoogleWalletForm } from "#templates/admin/settings/google-wallet.tsx";
import { PublicApiForm } from "#templates/admin/settings/public-api.tsx";
import { SmsGatewayForm } from "#templates/admin/settings/sms-gateway.tsx";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
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
  listingColumnOrder: string;
  attendeeColumnOrder: string;
  paymentProvider: string;
  smsGatewayUsername: string;
  smsGatewayBaseUrl: string;
  smsGatewayPasswordConfigured: boolean;
  smsGatewayPassphraseConfigured: boolean;
  smsGatewayWebhookConfigured: boolean;
};

export const adminAdvancedSettingsPage = (
  session: AdminSession,
  s: AdvancedSettingsPageState,
): string =>
  String(
    <Layout theme={s.theme} title={t("settings.advanced.title")}>
      <AdminNav active="/admin/settings" session={session}>
        <SettingsSubNav />
      </AdminNav>
      <article>
        <aside>
          <p>{t("settings.advanced.warning")}</p>
        </aside>
      </article>

      {EmailNotificationsForm(s)}
      {HostSubdomainForm(s)}
      {CustomDomainForm(s)}
      {ConfirmationEmailTemplateForm(s)}
      {AdminEmailTemplateForm(s)}
      {ListingColumnOrderForm(s)}
      {AttendeeColumnOrderForm(s)}
      {PublicApiForm(s)}
      {GoogleWalletForm(s)}
      {AppleWalletForm(s)}
      {SmsGatewayForm(s)}

      <ResetDatabaseForm
        action="/admin/settings/reset-database"
        id="settings-reset-database"
      />
    </Layout>,
  );
