/**
 * Admin advanced settings page template
 */

import { t } from "#i18n";
import type { AddressLookupSetting } from "#shared/address-lookup/types.ts";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { ResetDatabaseForm } from "#templates/admin/database-reset.tsx";
import { AddressLookupForm } from "#templates/admin/settings/address-lookup.tsx";
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
import { settingsPage } from "#templates/admin/settings/page-shell.tsx";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { SmsGatewayForm } from "#templates/admin/settings/sms-gateway.tsx";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
import type { EmailContent } from "#templates/email/shared.ts";

export type AdvancedSettingsPageState = {
  addressLookupProvider: AddressLookupSetting;
  addressLookupApiKeyConfigured: boolean;
  showPublicApi: boolean;
  externalOrderEnabled: boolean;
  emailProvider: string;
  emailApiKeyConfigured: boolean;
  emailFromAddress: string;
  hostEmailLabel: string;
  businessEmail: string;
  confirmationTemplates: EmailContent;
  adminTemplates: EmailContent;
  bunnyCdnEnabled: boolean;
  bunnyDnsEnabled: boolean;
  bunnySubdomain: string;
  bunnyDnsSubdomainSuffix: string;
  subdomainPreview: string;
  subdomainPreviewFullDomain: string;
  customCss: string;
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
  paymentProvider: string | null;
  smsGatewayUsername: string;
  smsGatewayBaseUrl: string;
  smsGatewayPasswordConfigured: boolean;
  smsGatewayPassphraseConfigured: boolean;
  smsGatewayWebhookConfigured: boolean;
  scheduledTaskKey: string | undefined;
};

export const adminAdvancedSettingsPage = (
  session: AdminSession,
  s: AdvancedSettingsPageState,
): string =>
  settingsPage(t("settings.advanced.title"), "/admin/settings-advanced")(
    session,
    s.theme,
  )(
    <>
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
      {settingsForm(SETTINGS_FORMS.customCss, s)}
      {settingsForm(SETTINGS_FORMS.showPublicApi, s)}
      {settingsForm(SETTINGS_FORMS.externalOrder, s)}
      {GoogleWalletForm(s)}
      {AppleWalletForm(s)}
      {SmsGatewayForm(s)}
      {AddressLookupForm(s)}

      <article class="prose">
        <h2>{t("settings.advanced.scheduled_title")}</h2>
        <p>{t("settings.advanced.scheduled_intro")}</p>
        {s.scheduledTaskKey ? (
          <code>{s.scheduledTaskKey}</code>
        ) : (
          <p>{t("settings.advanced.scheduled_unset")}</p>
        )}
      </article>

      <ResetDatabaseForm
        action="/admin/settings/reset-database"
        id="settings-reset-database"
      />
    </>,
  );
