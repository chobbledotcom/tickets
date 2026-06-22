/**
 * Admin Support page template — message the platform host.
 *
 * Shows the host-configured SUPPORT_PAGE_TEXT (markdown), a repeat-submit nag
 * within the configured window, and a message form when a business email is
 * set. Rendered only when the Support feature is enabled (ADMIN_EMAIL_ADDRESS).
 */

import { t } from "#i18n";
import { CsrfForm, Flash, MessageFields } from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Message form delivering to the platform host (no Botpoison). Just a message
 * box: support always comes from the site's own business email, so there's no
 * address for the operator to enter. When the operator submitted recently, a
 * notice sits between the box and the button to discourage repeat sends. */
const SupportForm = ({
  nagLabel,
}: {
  nagLabel: string | null;
}): JSX.Element => (
  <CsrfForm action="/admin/support">
    <h2>{t("support.contact_support")}</h2>
    <MessageFields>
      {nagLabel && (
        <p>
          <Raw
            html={t("support.last_submitted", {
              nagLabel: escapeHtml(nagLabel),
            })}
          />
        </p>
      )}
    </MessageFields>
  </CsrfForm>
);

/** Fallback shown when the host hasn't set SUPPORT_PAGE_TEXT. */
const MissingText = (): JSX.Element => (
  <p>
    <Raw html={t("support.missing_text")} />
  </p>
);

export const adminSupportPage = (opts: {
  session: AdminSession;
  supportText: string | null;
  formActive: boolean;
  nagLabel: string | null;
  success?: string;
  error?: string;
}): string =>
  String(
    <Layout title={t("support.page_title")}>
      <AdminNav active="/admin/settings" session={opts.session} />
      <Flash error={opts.error} success={opts.success} />
      <div class="prose">
        {opts.supportText ? (
          <Raw html={renderMarkdown(opts.supportText)} />
        ) : (
          <MissingText />
        )}
      </div>
      {opts.formActive && <SupportForm nagLabel={opts.nagLabel} />}
    </Layout>,
  );
