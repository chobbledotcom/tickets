/**
 * Admin bulk email templates — compose and preview pages.
 */

import {
  AUDIENCES,
  type BulkEmailDraft,
  type BulkEmailTarget,
  MAX_BULK_EMAIL_SUBJECT_LENGTH,
  targetQuery,
} from "#shared/bulk-email.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

const NAV_ACTIVE = "/admin/emails";

export type BulkEmailComposeState = {
  target: BulkEmailTarget;
  /** Present when target.kind === "listing". */
  listingName?: string;
  recipientCount: number;
  canBulkSend: boolean;
  /** Why provider sending is unavailable ("" when it is available). */
  disabledReason: string;
  /** Existing saved draft, used to repopulate the form. */
  draft: BulkEmailDraft | null;
};

/** The audience/listing selector at the top of the compose form. */
const TargetField = ({
  state,
}: {
  state: BulkEmailComposeState;
}): JSX.Element => {
  if (state.target.kind === "listing") {
    return (
      <>
        <input name="listing_id" type="hidden" value={state.target.listingId} />
        <p>
          <strong>Recipients:</strong> attendees of {state.listingName}
        </p>
      </>
    );
  }
  const selected = state.target.audience;
  return (
    <label>
      Audience
      <select name="audience">
        {AUDIENCES.map((a) => (
          <option selected={selected === a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
};

/**
 * Bulk email compose page. The Preview button always works (so the mailto
 * fallback is reachable); provider sending is gated later, on the preview page.
 */
export const bulkEmailComposePage = (
  session: AdminSession,
  state: BulkEmailComposeState,
): string => {
  const { draft } = state;
  return String(
    <Layout title="Send a bulk email">
      <AdminNav active={NAV_ACTIVE} session={session} />
      <Flash />

      <h1>Send a bulk email</h1>
      <p>
        Email your attendees about an upcoming listing or other news. Choose who
        receives it, write your message in Markdown, then preview before
        sending.
      </p>

      {!state.canBulkSend && (
        <div class="prose">
          <p>
            <strong>Heads up:</strong> {state.disabledReason} You can still
            compose and preview, then use the BCC email-app option on the
            preview page.
          </p>
        </div>
      )}

      <CsrfForm action="/admin/emails/preview" id="bulk-email">
        <TargetField state={state} />

        <label>
          Subject
          <input
            autocomplete="off"
            maxlength={MAX_BULK_EMAIL_SUBJECT_LENGTH}
            name="subject"
            required
            type="text"
            value={draft?.subject || undefined}
          />
        </label>

        <label>
          Message (Markdown)
          <textarea maxlength={MAX_TEXTAREA_LENGTH} name="body" required>
            {draft?.body ?? ""}
          </textarea>
        </label>

        <label>
          <input
            checked={draft?.marketing ?? false}
            name="marketing"
            type="checkbox"
            value="1"
          />{" "}
          This is a marketing email (adds an unsubscribe footer and skips
          unsubscribed people)
        </label>

        <div class="prose">
          <p>
            This selection currently reaches{" "}
            <strong>{state.recipientCount}</strong> recipient
            {state.recipientCount === 1 ? "" : "s"} — everyone who gave an email
            address, de-duplicated. Preview to confirm the exact list for your
            final selection.
          </p>
        </div>

        <button type="submit">Preview</button>
      </CsrfForm>
    </Layout>,
  );
};

export type BulkEmailPreviewState = {
  draft: BulkEmailDraft;
  /** Human label for the target: audience label or listing name. */
  targetLabel: string;
  /** Audience description (omitted for single-listing sends). */
  audienceDescription?: string;
  recipientCount: number;
  skippedCount: number;
  sendableCount: number;
  canBulkSend: boolean;
  disabledReason: string;
  /** Provider display name, e.g. "Resend" (only when canBulkSend). */
  providerLabel: string;
  mailtoLink: string;
};

/** Plain-language explanation of marketing vs transactional. */
const TypeExplainer = ({ marketing }: { marketing: boolean }): JSX.Element =>
  marketing ? (
    <p>
      <strong>Marketing email.</strong> These go to people who gave you their
      address to book tickets, not to receive promotions. Over-using them can
      breach anti-spam rules (such as GDPR/PECR or CAN-SPAM) and damage your
      sender reputation. Every email gets an unsubscribe link, and anyone who
      has already unsubscribed is skipped automatically.
    </p>
  ) : (
    <p>
      <strong>Transactional / service email.</strong> Treated as essential
      information about a listing someone booked — no unsubscribe footer is
      added and unsubscribed people are still included. Only use this for
      genuine listing info, never promotions.
    </p>
  );

/**
 * Bulk email preview page — renders the message and reiterates the facts, with
 * the final Send button (disabled without a bulk-capable provider) and an
 * always-present BCC mailto fallback.
 */
export const bulkEmailPreviewPage = (
  session: AdminSession,
  state: BulkEmailPreviewState,
): string => {
  const { draft } = state;
  const recipients = `${state.sendableCount} recipient${
    state.sendableCount === 1 ? "" : "s"
  }`;
  return String(
    <Layout title="Preview bulk email">
      <AdminNav active={NAV_ACTIVE} session={session} />
      <Flash />

      <h1>Preview bulk email</h1>
      <p>
        <a href={`/admin/emails${targetQuery(draft.target)}`}>← Edit message</a>
      </p>

      <div class="prose">
        <p>
          <strong>To:</strong> {state.targetLabel} — {recipients}
          {state.skippedCount > 0
            ? ` (${state.skippedCount} unsubscribed will be skipped)`
            : ""}
        </p>
        {state.audienceDescription && (
          <p>
            <small>{state.audienceDescription}</small>
          </p>
        )}
        <p>
          <strong>Subject:</strong> {draft.subject}
        </p>
        <TypeExplainer marketing={draft.marketing} />
      </div>

      <h2>Message preview</h2>
      <article class="prose">
        <Raw html={renderMarkdown(draft.body)} />
      </article>
      {draft.marketing && (
        <p>
          <small>
            A personalized unsubscribe footer is appended to each marketing
            email.
          </small>
        </p>
      )}

      <h2>Send through your email provider</h2>
      {state.canBulkSend ? (
        <CsrfForm action="/admin/emails/send" id="bulk-email-send">
          <button type="submit">
            Send to {recipients} via {state.providerLabel}
          </button>
        </CsrfForm>
      ) : (
        <>
          <p>
            <strong>Sending is disabled.</strong> {state.disabledReason}
          </p>
          <button disabled type="button">
            Send to {recipients}
          </button>
        </>
      )}

      <h2>Or send from your own email app</h2>
      <p>
        This opens your email app with everyone in BCC. It needs no provider
        setup, but sending lots of mail this way — especially marketing — is a
        quick way to get your account rate-limited or blocked. Best for small,
        genuinely transactional messages.
      </p>
      <p>
        <a href={state.mailtoLink}>Open a BCC draft to {recipients}</a>
      </p>
    </Layout>,
  );
};
