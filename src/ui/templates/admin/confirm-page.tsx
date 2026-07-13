/**
 * Shared confirm-page scaffolding for admin "type the name to confirm" pages.
 *
 * Several admin confirmation pages (attendee delete/refund/resend, question
 * delete, etc.) wrap a `<ConfirmForm>` in the standard `<AdminPage>` + `<Flash>`
 * opener, with a leading warning paragraph and a page-specific body. This
 * factors that wrapper out so the scaffolding lives in one place.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { ConfirmForm } from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

/** A translate-key + the args to pass to t(). */
export type TCall = { key: string; args?: Record<string, unknown> };

export type ConfirmPageProps = {
  title: string;
  active: NavActive;
  session: AdminSession;
  error?: string | undefined;
  /** Optional content rendered between AdminPage's header and the Flash/error
   *  notice — used by bulk-actions to render its "back to bulk-actions" link. */
  prefix?: Child;
  /** The ConfirmForm action URL. */
  action: string;
  /** The ConfirmForm submit-button text. */
  buttonText: string;
  /** The ConfirmForm confirmation label (the "type X to confirm" prompt). */
  label: string;
  /** The ConfirmForm identifier shown as the "type this to confirm" target. */
  name: string;
  returnUrl?: string | undefined;
  /** Optional ConfirmForm id (e.g. for the test/restore-confirm form). */
  id?: string | undefined;
  /** Optional hidden form fields passed to ConfirmForm. */
  hiddenFields?: Record<string, string>;
  /** Whether to render the form with `danger` styling. */
  danger?: boolean | undefined;
  /** Whether to skip the "type the name to confirm" input (just an
   *  are-you-sure button). Pass `false` to disable name confirmation. */
  confirmName?: boolean | undefined;
  /** Optional leading warning/note paragraph rendered before the body. */
  warning?: Child;
  /** Optional heading + confirm/prompt paragraph block rendered inside the
   *  ConfirmForm (after the warning, before explicit children). Models the
   *  common `<h1/><p><Raw html={t(...)}/></p><p>{t(...)}</p>` body shared by
   *  the holiday/logistics/attendee delete pages. */
  heading?: string;
  /** A `<Raw html={t(...)}/>` paragraph — usually the "this will delete X"
   *  warning rendered through t() so it can interpolate HTML. */
  confirm?: TCall;
  /** A plain-text note between the confirmation and prompt. */
  note?: TCall;
  /** A plain-text confirm prompt paragraph (e.g. "Type the name to confirm"). */
  prompt?: TCall;
  /** Page-specific body inside the ConfirmForm, rendered after the
   *  heading/confirm/prompt block. */
  children?: Child;
};

export const ConfirmPage = ({
  title,
  active,
  session,
  error,
  prefix,
  action,
  buttonText,
  label,
  name,
  returnUrl,
  id,
  hiddenFields,
  danger,
  confirmName,
  warning,
  heading,
  confirm,
  note,
  prompt,
  children,
}: ConfirmPageProps): string =>
  renderAdminPage(
    active,
    session,
    title,
    <>
      {prefix}
      <Flash error={error} />
      <ConfirmForm
        action={action}
        buttonText={buttonText}
        {...(danger !== undefined ? { danger } : {})}
        {...(hiddenFields !== undefined ? { hiddenFields } : {})}
        {...(id !== undefined ? { id } : {})}
        {...(confirmName !== undefined ? { confirmName } : {})}
        label={label}
        name={name}
        returnUrl={returnUrl}
      >
        {warning}
        {heading !== undefined && <h1>{heading}</h1>}
        {confirm && (
          <p>
            <Raw html={t(confirm.key, confirm.args)} />
          </p>
        )}
        {note && <p>{t(note.key, note.args)}</p>}
        {prompt && <p>{t(prompt.key, prompt.args)}</p>}
        {children}
      </ConfirmForm>
    </>,
  );
