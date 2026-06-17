/**
 * Public email-preferences (unsubscribe / resubscribe) page.
 *
 * Identifies the recipient only by the opaque email hash from their link, so
 * the address is never shown. Both actions are POSTs (a GET must never change
 * subscription state — link prefetchers and scanners follow GETs).
 */

import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

export type UnsubscribeState = {
  /** Opaque email hash from the link, or null when missing/invalid. */
  hash: string | null;
  unsubscribed: boolean;
  success?: string;
  error?: string;
  info?: string;
};

/** The toggle form — carries the hash and the action, never the address. */
const ToggleForm = ({
  hash,
  action,
  label,
}: {
  hash: string;
  action: "unsubscribe" | "resubscribe";
  label: string;
}): JSX.Element => (
  <CsrfForm action="/unsubscribe" class="inline" id="unsubscribe">
    <input name="email" type="hidden" value={hash} />
    <input name="action" type="hidden" value={action} />
    <button type="submit">{label}</button>
  </CsrfForm>
);

export const unsubscribePage = (state: UnsubscribeState): string => {
  const title = settings.websiteTitle
    ? `${t("unsubscribe.email_preferences")} - ${settings.websiteTitle}`
    : t("unsubscribe.email_preferences");
  return String(
    <Layout title={title}>
      <h1>{t("unsubscribe.email_preferences")}</h1>
      <Flash error={state.error} info={state.info} success={state.success} />
      {!state.hash ? (
        <div class="prose">
          <p>{t("unsubscribe.invalid_link")}</p>
        </div>
      ) : state.unsubscribed ? (
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
    </Layout>,
  );
};
