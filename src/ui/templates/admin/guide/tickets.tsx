/**
 * Admin guide — Tickets sections.
 */

import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import {
  custom,
  faq,
  type GuideHostConfig,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

/**
 * The body of a wallet (Apple/Google) setup answer. Both wallets share the
 * same shape — an optional "already set up by the host" note, a plain-language
 * note saying who this set-up is for, the credential intro, the list of
 * required values, and a closing note — so the whole structure lives here once
 * and each call site supplies only what differs: the wallet name, the
 * developer account, how many values are needed, the host-configured id (with
 * its label), the localized note, and the list items themselves.
 */
const WalletSetup = ({
  account,
  configuredLabel,
  configuredValue,
  count,
  items,
  note,
  wallet,
}: {
  account: string;
  configuredLabel: string;
  configuredValue?: string | null | undefined;
  count: string;
  items: Child;
  note: string;
  wallet: string;
}): JSX.Element => (
  <>
    {configuredValue && (
      <p>
        {wallet} is already set up by the company that runs your site, using{" "}
        {configuredLabel} <code>{configuredValue}</code>. The Add to {wallet}{" "}
        button should already appear on all ticket pages. You can use your own
        details instead — enter them in <a href="/admin/settings">Settings</a>.
      </p>
    )}
    <p>{note}</p>
    <p>
      Go to <a href="/admin/settings">Settings</a>, click{" "}
      <strong>Advanced Settings</strong>, and find the <strong>{wallet}</strong>{" "}
      section. You need {count} values from your {account} account:
    </p>
    <ol>{items}</ol>
    <p>
      All {count} fields are required. Once saved, the Add to {wallet} button
      appears automatically on all ticket pages. When none are set up, the
      button is hidden.
    </p>
  </>
);

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
        <WalletSetup
          account="Apple Developer"
          configuredLabel="pass type"
          configuredValue={hostConfig?.hostAppleWalletPassTypeId}
          count="five"
          items={
            <>
              <li>
                <strong>Pass Type ID</strong> &mdash; for example{" "}
                <code>pass.com.example.tickets</code>
              </li>
              <li>
                <strong>Team ID</strong> &mdash; your Apple Developer Team ID
              </li>
              <li>
                <strong>Signing Certificate</strong> &mdash; the certificate
                file for your Pass Type ID, in PEM format (a text file starting
                with BEGIN CERTIFICATE)
              </li>
              <li>
                <strong>Signing Key</strong> &mdash; the private key for that
                certificate, in PEM format
              </li>
              <li>
                <strong>WWDR Certificate</strong> &mdash; Apple's own
                certificate, downloadable from the Apple Developer portal
              </li>
            </>
          }
          note={t("guide.wallet_setup.apple_note")}
          wallet="Apple Wallet"
        />,
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
        <WalletSetup
          account="Google Cloud"
          configuredLabel="issuer ID"
          configuredValue={hostConfig?.hostGoogleWalletIssuerId}
          count="three"
          items={
            <>
              <li>
                <strong>Issuer ID</strong> &mdash; from the{" "}
                <a href="https://pay.google.com/business/console/">
                  Google Wallet Business Console
                </a>
              </li>
              <li>
                <strong>Service Account Email</strong> &mdash; the address of a
                service account (a login for a program, not a person) with the
                Google Wallet API switched on
              </li>
              <li>
                <strong>Service Account Private Key</strong> &mdash; the{" "}
                <code>private_key</code> value from the service account's JSON
                key file, in PEM format
              </li>
            </>
          }
          note={t("guide.wallet_setup.google_note")}
          wallet="Google Wallet"
        />,
      ),
      faq("do_google_wallet_passes_update_automatically"),
    ],
    id: "google-wallet",
    titleKey: "google_wallet",
  },
];
