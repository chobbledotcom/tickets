/**
 * Admin Support page template — message the platform host.
 *
 * Shows the host-configured SUPPORT_PAGE_TEXT (markdown), a repeat-submit nag
 * within the configured window, and a message form when a business email is
 * set. Rendered only when the Support feature is enabled (ADMIN_EMAIL_ADDRESS).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { MessageFields } from "#shared/forms/message-fields.tsx";
import { renderMarkdown } from "#shared/markdown.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { RawParagraph } from "#templates/components/prose-heading.tsx";
import type { AdminSession } from "#types";

/* jscpd:ignore-end */

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

export const adminSupportPage = (opts: {
  session: AdminSession;
  supportText: string | null;
  formActive: boolean;
  nagLabel: string | null;
  success?: string | undefined;
  error?: string | undefined;
}): string =>
  flashAdminPage(t("support.page_title"), "/admin/support")(
    opts.session,
    opts.error,
    opts.success,
  )(
    <>
      <div class="prose">
        {opts.supportText ? (
          <Raw html={renderMarkdown(opts.supportText)} />
        ) : (
          <RawParagraph html={t("support.missing_text")} />
        )}
      </div>
      {opts.formActive && <SupportForm nagLabel={opts.nagLabel} />}
      <GuideFooter href="/admin/guide#support">
        {t("support.guide_link")}
      </GuideFooter>
    </>,
  );
