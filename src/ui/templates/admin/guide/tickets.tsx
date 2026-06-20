/**
 * Admin guide — Tickets sections.
 */

import {
  custom,
  faq,
  type GuideHostConfig,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const ticketsSections = (
  hostConfig?: GuideHostConfig,
): GuideSection[] => [
  {
    entries: [
      faq("how_checkin_works"),
      faq("qr_code_purpose"),
      faq("use_qr_scanner"),
      faq("scanner_no_checkout"),
      faq("qr_different_listing"),
      faq("scanner_status_messages"),
      faq("what_if_someone_doesn_t_have_their"),
      faq("how_do_i_filter_attendees_by_check"),
    ],
    id: "checkin",
    titleKey: "check_in_and_qr_scanner",
  },
  {
    entries: [
      faq("what_is_apple_wallet"),
      custom(
        "setup_apple_wallet",
        <>
          {hostConfig?.hostAppleWalletPassTypeId && (
            <p>
              Apple Wallet is already configured by your server administrator
              using pass type{" "}
              <code>{hostConfig.hostAppleWalletPassTypeId}</code>. The Add to
              Apple Wallet button should appear automatically on all ticket
              pages. You can override this by entering your own credentials in{" "}
              <a href="/admin/settings">Settings</a>.
            </p>
          )}
          <p>
            Go to <a href="/admin/settings">Settings</a>, click{" "}
            <strong>Advanced Settings</strong>, and find the{" "}
            <strong>Apple Wallet</strong> section. You need five values from
            your Apple Developer account:
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
              <strong>Signing Certificate</strong> &mdash; PEM-encoded
              certificate for your Pass Type ID
            </li>
            <li>
              <strong>Signing Key</strong> &mdash; PEM-encoded private key for
              the certificate
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
        </>,
      ),
      faq("wallet_passes_update"),
    ],
    id: "apple-wallet",
    titleKey: "apple_wallet",
  },
  {
    entries: [
      faq("what_is_google_wallet_integration"),
      custom(
        "setup_google_wallet",
        <>
          {hostConfig?.hostGoogleWalletIssuerId && (
            <p>
              Google Wallet is already configured by your server administrator
              using issuer ID <code>{hostConfig.hostGoogleWalletIssuerId}</code>
              . The Add to Google Wallet button should appear automatically on
              all ticket pages. You can override this by entering your own
              credentials in <a href="/admin/settings">Settings</a>.
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
              <strong>Service Account Private Key</strong> &mdash; PEM-encoded
              RSA private key for the service account
            </li>
          </ol>
          <p>
            All three fields are required. Once saved, the Add to Google Wallet
            button appears automatically on all ticket pages. If none are
            configured, the feature is simply hidden.
          </p>
        </>,
      ),
      faq("do_google_wallet_passes_update_automatically"),
    ],
    id: "google-wallet",
    titleKey: "google_wallet",
  },
];
