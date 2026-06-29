/**
 * Public contact-preferences (unsubscribe / resubscribe / forget) page.
 *
 * Identifies the recipient only by the opaque contact hash from their link, so
 * the address is never shown. Actions are POSTs (a GET must never change
 * contact state — link prefetchers and scanners follow GETs).
 */

import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

export type UnsubscribeState = {
  /** Opaque contact hash from the link, or null when missing/invalid. */
  hash: string | null;
  unsubscribed: boolean;
  success?: string | undefined;
  error?: string | undefined;
  info?: string | undefined;
};

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
    <input name="action" type="hidden" value={action} />
    <button class={danger ? "danger" : undefined} type="submit">
      {label}
    </button>
  </CsrfForm>
);

const ForgetSection = ({ hash }: { hash: string }): JSX.Element => (
  <div class="prose">
    <h2>{t("unsubscribe.forget_heading")}</h2>
    <p>{t("unsubscribe.forget_explainer")}</p>
    <ToggleForm
      action="forget"
      danger
      hash={hash}
      label={t("unsubscribe.forget_button")}
    />
  </div>
);

export const unsubscribePage = (state: UnsubscribeState): string => {
  const title = settings.websiteTitle
    ? `${t("unsubscribe.email_preferences")} - ${settings.websiteTitle}`
    : t("unsubscribe.email_preferences");
  return String(
    <Layout title={title}>
      <h1>{t("unsubscribe.email_preferences")}</h1>
      <Flash
        {...(state.error !== undefined ? { error: state.error } : {})}
        {...(state.info !== undefined ? { info: state.info } : {})}
        {...(state.success !== undefined ? { success: state.success } : {})}
      />
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
