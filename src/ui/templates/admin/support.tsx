/**
 * Admin Support page template — message the platform host.
 *
 * Shows the host-configured SUPPORT_PAGE_TEXT (markdown), a repeat-submit nag
 * within the configured window, and a message form when a business email is
 * set. Rendered only when the Support feature is enabled (ADMIN_EMAIL_ADDRESS).
 */

import { CsrfForm, Flash, MessageFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Message form delivering to the platform host (no Botpoison). The email box
 * is pre-filled read-only with the site's business email: support always comes
 * from that address, so there's nothing for the operator to type or change. */
const SupportForm = ({
  businessEmail,
}: {
  businessEmail: string;
}): JSX.Element => (
  <CsrfForm action="/admin/support">
    <h2>Contact support</h2>
    <MessageFields email={businessEmail} />
  </CsrfForm>
);

/** Fallback shown when the host hasn't set SUPPORT_PAGE_TEXT. */
const MissingText = (): JSX.Element => (
  <p>
    Your admin hasn't filled in the <code>SUPPORT_PAGE_TEXT</code> variable,
    which is why you're seeing this strange message.
  </p>
);

export const adminSupportPage = (opts: {
  session: AdminSession;
  supportText: string | null;
  formActive: boolean;
  businessEmail: string;
  nagLabel: string | null;
  success?: string;
  error?: string;
}): string =>
  String(
    <Layout title="Support">
      <AdminNav active="/admin/support" session={opts.session} />
      <Flash error={opts.error} success={opts.success} />
      <div class="prose">
        {opts.supportText ? (
          <Raw html={renderMarkdown(opts.supportText)} />
        ) : (
          <MissingText />
        )}
      </div>
      {opts.nagLabel && <p>You last submitted this form {opts.nagLabel}.</p>}
      {opts.formActive ? (
        <SupportForm businessEmail={opts.businessEmail} />
      ) : (
        <p class="error" role="alert">
          Set a business email on the <a href="/admin/settings">Settings</a>{" "}
          page to enable the support form.
        </p>
      )}
    </Layout>,
  );
