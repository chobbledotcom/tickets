/**
 * Renewal-specific page templates. The picker itself is rendered by
 * `ticketPage` (shared with /ticket and /g/<slug>) — this file only holds
 * the error page shown when no qualifying renewal tier is configured.
 */

import { escapeHtml, Layout } from "#templates/layout.tsx";

type RenewalErrorPageProps = {
  siteName: string;
};

/** Render the renewal error page (no qualifying renewal tier exists) */
export const renewalErrorPage = ({ siteName }: RenewalErrorPageProps): string =>
  String(
    <Layout title="Renewal Unavailable">
      <div class="prose">
        <h1>Renewal Unavailable</h1>
        <p>
          This renewal link is no longer valid for{" "}
          <strong>{escapeHtml(siteName)}</strong>. Please contact support.
        </p>
      </div>
    </Layout>,
  );
