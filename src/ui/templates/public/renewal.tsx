/**
 * Renewal-specific page templates. The picker itself is rendered by
 * `ticketPage` (shared with /ticket and /g/<slug>) — this file only holds
 * the error page shown when no qualifying renewal tier is configured.
 */

import { t } from "#i18n";
import { escapeHtml, Layout } from "#templates/layout.tsx";

type RenewalErrorPageProps = {
  siteName: string;
};

/** Render the renewal error page (no qualifying renewal tier exists) */
export const renewalErrorPage = ({ siteName }: RenewalErrorPageProps): string =>
  String(
    <Layout title={t("public_renewal.unavailable")}>
      <div class="prose">
        <h1>{t("public_renewal.unavailable")}</h1>
        <p>
          {t("public_renewal.link_invalid_for", {
            siteName: escapeHtml(siteName),
          })}{" "}
          {t("public_renewal.contact_support")}
        </p>
      </div>
    </Layout>,
  );
