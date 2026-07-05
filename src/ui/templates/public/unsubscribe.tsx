/**
 * Public contact-preferences (unsubscribe / resubscribe / forget) page.
 *
 * Identifies the recipient only by the opaque contact hash from their link, so
 * the address is never shown. Actions are POSTs (a GET must never change
 * contact state — link prefetchers and scanners follow GETs).
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { Layout } from "#templates/layout.tsx";
/* jscpd:ignore-end */

export type UnsubscribeState = {
  /** Opaque contact hash from the link, or null when missing/invalid. */
  hash: string | null;
  unsubscribed: boolean;
  success?: string | undefined;
  error?: string | undefined;
  info?: string | undefined;
};

/** A `<div class="prose">` section led by an `<h2>` heading, wrapping the
 *  page-specific body. Shared by the admin attendee-details block and the
 *  public forget/contact-preferences section, so the wrapper markup can't
 *  drift between admin and public. */
export const ProseSection = ({
  children,
  heading,
}: {
  children?: Child;
  heading: string;
}): JSX.Element => (
  <div class="prose">
    <h2>{heading}</h2>
    {children}
  </div>
);

/** A hidden form field paired with the form's submit button — the shared tail
 *  of the unsubscribe action forms and the admin check-in form. */
export const SubmitWithHidden = ({
  buttonClass,
  label,
  name,
  value,
}: {
  buttonClass?: string | undefined;
  label: Child;
  name: string;
  value: string;
}): JSX.Element => (
  <>
    <input name={name} type="hidden" value={value} />
    <button class={buttonClass} type="submit">
      {label}
    </button>
  </>
);

/** The action form — carries the hash and the action, never the address. */
const ToggleForm = ({
  hash,
  action,
  label,
  danger,
}: {
  hash: string;
  action: "unsubscribe" | "resubscribe" | "forget";
  label: string;
  danger?: boolean;
}): JSX.Element => (
  <CsrfForm action="/unsubscribe" class="inline" id={`action-${action}`}>
    <input name="email" type="hidden" value={hash} />
    <SubmitWithHidden
      buttonClass={danger ? "danger" : undefined}
      label={label}
      name="action"
      value={action}
    />
  </CsrfForm>
);

const ForgetSection = ({ hash }: { hash: string }): JSX.Element => (
  <ProseSection heading={t("unsubscribe.forget_heading")}>
    <p>{t("unsubscribe.forget_explainer")}</p>
    <ToggleForm
      action="forget"
      danger
      hash={hash}
      label={t("unsubscribe.forget_button")}
    />
  </ProseSection>
);

export const unsubscribePage = (state: UnsubscribeState): string => {
  const title = settings.websiteTitle
    ? `${t("unsubscribe.email_preferences")} - ${settings.websiteTitle}`
    : t("unsubscribe.email_preferences");
  return String(
    <Layout title={title}>
      <h1>{t("unsubscribe.email_preferences")}</h1>
      <Flash {...flashProps(state.error, state.success, state.info)} />
      {!state.hash ? (
        <div class="prose">
          <p>{t("unsubscribe.invalid_link")}</p>
        </div>
      ) : (
        <>
          {state.unsubscribed ? (
            <div class="prose">
              <p>
                <Raw html={t("unsubscribe.unsubscribed_message")} />
              </p>
              <p>{t("unsubscribe.changed_mind")}</p>
              <ToggleForm
                action="resubscribe"
                hash={state.hash}
                label={t("unsubscribe.resubscribe_button")}
              />
            </div>
          ) : (
            <div class="prose">
              <p>{t("unsubscribe.subscribed_message")}</p>
              <ToggleForm
                action="unsubscribe"
                hash={state.hash}
                label={t("unsubscribe.unsubscribe_button")}
              />
            </div>
          )}
          <ForgetSection hash={state.hash} />
        </>
      )}
    </Layout>,
  );
};
