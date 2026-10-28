/**
 * The shared frame for pages that edit one entry belonging to a parent record
 * (a question's answer, an attribute's option). It holds the admin page
 * shell, a back link to the parent, and the heading with a small line naming
 * the parent. Below sit the entry's edit form and the page's own sections
 * (stats, related records, the delete link).
 */

import type { Child } from "#jsx/jsx-runtime.ts";
/* jscpd:ignore-start */
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { BackButton } from "#templates/components/actions.tsx";
import type { AdminSession } from "#types";
/* jscpd:ignore-end */

export type ChildEditFrame = {
  /** The nav item to mark active, for example "/admin/questions". */
  active: string;
  /** Link back to the parent record's page. */
  backHref: string;
  backLabel: string;
  /** Small line under the heading naming the parent record. */
  context: string;
  /** POST target of the entry's edit form. */
  formAction: string;
  heading: string;
  title: string;
};

export const childEditPage =
  (frame: ChildEditFrame) =>
  (
    session: AdminSession,
    error: string | undefined,
    formContent: Child,
    after: Child,
  ): string =>
    errorAdminPage(frame.title, frame.active)(session, error)(
      <>
        <p>
          <BackButton href={frame.backHref}>{frame.backLabel}</BackButton>
        </p>

        <div class="prose">
          <h1>{frame.heading}</h1>
          <p>
            <small>{frame.context}</small>
          </p>
        </div>

        <CsrfForm action={frame.formAction}>{formContent}</CsrfForm>

        {after}
      </>,
    );
