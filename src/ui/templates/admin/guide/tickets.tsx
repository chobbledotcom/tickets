/**
 * Admin guide — Tickets sections.
 */

import { t } from "#i18n";
import {
  Faq,
  type GuideHostConfig,
  Q,
  Section,
} from "#templates/admin/guide/components.tsx";

export const Tickets = ({
  hostConfig,
}: {
  hostConfig?: GuideHostConfig;
}): JSX.Element => (
  <>
    <Section id="checkin" title={t("guide.sections.check_in_and_qr_scanner")}>
      <Faq id="how_checkin_works" />

      <Faq id="qr_code_purpose" />

      <Faq id="use_qr_scanner" />

      <Faq id="scanner_no_checkout" />

      <Faq id="qr_different_listing" />

      <Faq id="scanner_status_messages" />

      <Faq id="what_if_someone_doesn_t_have_their" />

      <Faq id="how_do_i_filter_attendees_by_check" />
    </Section>

    <Section id="apple-wallet" title={t("guide.sections.apple_wallet")}>
      <Faq id="what_is_apple_wallet" />

      <Q q={t("guide.q.setup_apple_wallet")}>
        {hostConfig?.hostAppleWalletPassTypeId && (
          <p>
            Apple Wallet is already configured by your server administrator
            using pass type <code>{hostConfig.hostAppleWalletPassTypeId}</code>.
            The Add to Apple Wallet button should appear automatically on all
            ticket pages. You can override this by entering your own credentials
            in <a href="/admin/settings">Settings</a>.
          </p>
        )}
        <p>
          Go to <a href="/admin/settings">Settings</a>, click{" "}
          <strong>Advanced Settings</strong>, and find the{" "}
          <strong>Apple Wallet</strong> section. You need five values from your
          Apple Developer account:
        </p>
        <ol>
          <li>
            <strong>Pass Type ID</strong> &mdash; e.g.{" "}
            <code>pass.com.example.tickets</code>
          </li>
          <li>
            <strong>Team ID</strong> &mdash; your Apple Developer Team ID
          </li>
          <li>
            <strong>Signing Certificate</strong> &mdash; PEM-encoded certificate
            for your Pass Type ID
          </li>
          <li>
            <strong>Signing Key</strong> &mdash; PEM-encoded private key for the
            certificate
          </li>
          <li>
            <strong>WWDR Certificate</strong> &mdash; Apple's intermediate
            certificate (download from the Apple Developer portal)
          </li>
        </ol>
        <p>
          All five fields are required. Once saved, the Add to Apple Wallet
          button appears automatically on all ticket pages. If none are
          configured, the feature is simply hidden.
        </p>
      </Q>

      <Faq id="wallet_passes_update" />
    </Section>

    <Section id="google-wallet" title="Google Wallet">
      <Faq id="what_is_google_wallet_integration" />

      <Q q="How do I set up Google Wallet?">
        {hostConfig?.hostGoogleWalletIssuerId && (
          <p>
            Google Wallet is already configured by your server administrator
            using issuer ID <code>{hostConfig.hostGoogleWalletIssuerId}</code>.
            The Add to Google Wallet button should appear automatically on all
            ticket pages. You can override this by entering your own credentials
            in <a href="/admin/settings">Settings</a>.
          </p>
        )}
        <p>
          Go to <a href="/admin/settings">Settings</a>, click{" "}
          <strong>Advanced Settings</strong>, and find the{" "}
          <strong>Google Wallet</strong> section. You need three values from
          your Google Cloud account:
        </p>
        <ol>
          <li>
            <strong>Issuer ID</strong> &mdash; from the{" "}
            <a href="https://pay.google.com/business/console/">
              Google Wallet Business Console
            </a>
          </li>
          <li>
            <strong>Service Account Email</strong> &mdash; a Google Cloud
            service account with the Google Wallet API enabled
          </li>
          <li>
            <strong>Service Account Private Key</strong> &mdash; PEM-encoded RSA
            private key for the service account
          </li>
        </ol>
        <p>
          All three fields are required. Once saved, the Add to Google Wallet
          button appears automatically on all ticket pages. If none are
          configured, the feature is simply hidden.
        </p>
      </Q>

      <Faq id="do_google_wallet_passes_update_automatically" />
    </Section>
  </>
);
