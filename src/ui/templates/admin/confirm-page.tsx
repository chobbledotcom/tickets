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
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { ConfirmForm } from "#templates/components/save-form.tsx";
import type { AdminSession } from "#types";

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
  hiddenFields?: Record<string, string> | undefined;
  returnUrl?: string | undefined;
  /** Whether to render the form with `danger` styling. */
  danger?: boolean | undefined;
  /** Whether to skip the "type the name to confirm" input (just an
   *  are-you-sure button). Pass `false` to disable name confirmation. */
  confirmName?: boolean | undefined;
  /** A blocked confirmation explains the state but offers no submit button. */
  disabled?: boolean | undefined;
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

/** Curried builder for the many admin "delete this X" confirmation pages that
 *  all share the `(entity, session, error?) => ConfirmPage({...})` shape. Pass a
 *  function that turns the entity into the page-specific ConfirmPage props (its
 *  action URL, labels, confirm copy); the returned function binds the viewer's
 *  session and error notice. Keeps the one shared wrapper in one place. */
export const entityDeletePage =
  <Entity,>(
    build: (entity: Entity) => Omit<ConfirmPageProps, "session" | "error">,
  ): ((entity: Entity, session: AdminSession, error?: string) => string) =>
  (entity, session, error) =>
    ConfirmPage({ ...build(entity), error, session });

/** What a {@link warningDeletePage} says: everything but the nav highlight,
 *  which the curried factory binds. `title` falls back to the heading. */
export type WarningDeleteProps = {
  action: string;
  buttonText: string;
  heading: string;
  label: string;
  name: string;
  prompt: TCall;
  title?: string;
  warning: Child;
};

/** Delete confirmation page that opens with a warning paragraph — the shape
 *  the question, answer, attribute, and attribute-option delete pages share.
 *  Binds the nav highlight; the returned function takes the page's wording,
 *  the viewer's session, and the rejected-submit error. */
export const warningDeletePage = (
  active: NavActive,
): ((
  props: WarningDeleteProps,
  session: AdminSession,
  error?: string,
) => string) =>
  entityDeletePage(({ title, ...props }: WarningDeleteProps) => ({
    ...props,
    active,
    title: title ?? props.heading,
  }));

/** Type-the-name delete confirmation page for a record with an `id` and a
 *  `name` living under `base` (e.g. "/admin/site/news"). `messages` is the
 *  i18n prefix carrying `.delete_title`, `.delete_submit`, `.delete_prompt`
 *  (with a `{name}` slot), and `.name_label`. */
export const prefixedDeletePage = (
  messages: string,
  base: string,
): ((
  entity: { id: number; name: string },
  session: AdminSession,
  error?: string,
) => string) =>
  entityDeletePage((entity: { id: number; name: string }) => {
    const title = t(`${messages}.delete_title`);
    return {
      action: `${base}/${entity.id}/delete`,
      active: base,
      buttonText: t(`${messages}.delete_submit`),
      danger: true,
      heading: title,
      label: t(`${messages}.name_label`),
      name: entity.name,
      prompt: { args: { name: entity.name }, key: `${messages}.delete_prompt` },
      title,
    };
  });

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
  hiddenFields,
  returnUrl,
  danger,
  confirmName,
  disabled,
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
      {disabled ? (
        children
      ) : (
        <ConfirmForm
          action={action}
          buttonText={buttonText}
          {...(danger !== undefined ? { danger } : {})}
          {...(confirmName !== undefined ? { confirmName } : {})}
          {...(hiddenFields === undefined ? {} : { hiddenFields })}
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
      )}
    </>,
  );
