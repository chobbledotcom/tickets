/**
 * Public email-preferences (unsubscribe / resubscribe) page.
 *
 * Identifies the recipient only by the opaque email hash from their link, so
 * the address is never shown. Both actions are POSTs (a GET must never change
 * subscription state — link prefetchers and scanners follow GETs).
 */

import { settings } from "#shared/db/settings.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
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
    ? `Email preferences - ${settings.websiteTitle}`
    : "Email preferences";
  return String(
    <Layout title={title}>
      <h1>Email preferences</h1>
      <Flash error={state.error} info={state.info} success={state.success} />
      {!state.hash ? (
        <div class="prose">
          <p>
            This link is invalid or incomplete. Please use the unsubscribe link
            from one of our emails.
          </p>
        </div>
      ) : state.unsubscribed ? (
        <div class="prose">
          <p>
            You're <strong>unsubscribed</strong> from our marketing emails and
            won't receive them. You may still get essential messages about
            listings you've booked.
          </p>
          <p>Changed your mind?</p>
          <ToggleForm
            action="resubscribe"
            hash={state.hash}
            label="Resubscribe"
          />
        </div>
      ) : (
        <div class="prose">
          <p>You're currently subscribed to our marketing emails.</p>
          <ToggleForm
            action="unsubscribe"
            hash={state.hash}
            label="Unsubscribe"
          />
        </div>
      )}
    </Layout>,
  );
};
