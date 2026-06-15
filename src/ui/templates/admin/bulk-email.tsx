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
import { ActionButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

const NAV_ACTIVE = "/admin/emails";

/** Deep link to the Email Notifications form on the advanced settings page. */
const EMAIL_SETTINGS_LINK = "/admin/settings-advanced#settings-email";

export type BulkEmailComposeState = {
  target: BulkEmailTarget;
  /** Present when target.kind === "listing". */
  listingName?: string;
  /** The attendee's email address, when target.kind === "attendee" and one is
   * on file (used to label the single recipient). */
  attendeeEmail?: string;
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
  if (state.target.kind === "attendee") {
    return (
      <>
        <input name="attendee" type="hidden" value={state.target.token} />
        <p>
          <strong>Recipient:</strong> {state.attendeeEmail}
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
  const isAttendee = state.target.kind === "attendee";
  return String(
    <Layout title={isAttendee ? "Email an attendee" : "Send a bulk email"}>
      <AdminNav active={NAV_ACTIVE} session={session} />
      <Flash />

      <div class="prose">
        <h1>{isAttendee ? "Email an attendee" : "Send a bulk email"}</h1>
        <p>
          {isAttendee
            ? "Send a one-off email to this attendee. Write your message in Markdown, then preview before sending."
            : "Email your attendees about an upcoming listing or other news. Choose who receives it, write your message in Markdown, then preview before sending."}
        </p>
      </div>

      {!state.canBulkSend && (
        <div class="prose">
          <p>
            <strong>Heads up:</strong> {state.disabledReason} You can still
            compose and preview, then use the BCC email-app option on the
            preview page.
          </p>
          <p class="small">
            <a href={EMAIL_SETTINGS_LINK}>
              Set up your email provider in advanced settings
            </a>
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
          <textarea
            data-markdown-preview
            maxlength={MAX_TEXTAREA_LENGTH}
            name="body"
            required
          >
            {draft?.body ?? ""}
          </textarea>
        </label>

        <fieldset class="checkboxes">
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
        </fieldset>

        <div class="prose">
          {isAttendee ? (
            <p>Preview to confirm the message before sending.</p>
          ) : (
            <p>
              This selection currently reaches{" "}
              <strong>{state.recipientCount}</strong> recipient
              {state.recipientCount === 1 ? "" : "s"}. That's everyone who gave
              an email address, de-duplicated. Preview to confirm the exact list
              for your final selection.
            </p>
          )}
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
  /** The exact addresses that will be emailed, for copying. */
  sendableEmails: string[];
  canBulkSend: boolean;
  disabledReason: string;
  /** Provider display name, e.g. "Resend" (only when canBulkSend). */
  providerLabel: string;
  mailtoLink: string;
  /** One-line contact-frequency insight for the recipients ("" to omit). */
  contactSummary: string;
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
      information about a listing someone booked. No unsubscribe footer is added
      and unsubscribed people are still included. Only use this for genuine
      listing info, never promotions.
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

      <div class="prose">
        <h1>Preview bulk email</h1>
      </div>
      <p>
        <ActionButton
          href={`/admin/emails${targetQuery(draft.target)}`}
          icon="arrow-left"
          variant="secondary"
        >
          Edit message
        </ActionButton>
      </p>

      <div class="prose">
        <p>
          <strong>To:</strong> {state.targetLabel} ({recipients}
          {state.skippedCount > 0
            ? `, ${state.skippedCount} unsubscribed will be skipped`
            : ""}
          )
        </p>
        {state.audienceDescription && (
          <p class="small">{state.audienceDescription}</p>
        )}
        {state.contactSummary && <p class="small">{state.contactSummary}</p>}
        <p>
          <strong>Subject:</strong> {draft.subject}
        </p>
        <TypeExplainer marketing={draft.marketing} />
      </div>

      <div class="prose">
        <h2>Message preview</h2>
      </div>
      <article class="prose email-preview">
        <Raw html={renderMarkdown(draft.body)} />
      </article>
      {draft.marketing && (
        <div class="prose">
          <p class="small">
            A personalized unsubscribe footer is appended to each marketing
            email.
          </p>
        </div>
      )}

      <div class="prose">
        <h2>Send through your email provider</h2>
      </div>
      {state.canBulkSend ? (
        <CsrfForm
          action="/admin/emails/send"
          class="inline"
          id="bulk-email-send"
        >
          <button type="submit">
            Send to {recipients} via {state.providerLabel}
          </button>
        </CsrfForm>
      ) : (
        <>
          <div class="prose">
            <p>
              <strong>Sending is disabled.</strong> {state.disabledReason}
            </p>
            <p class="small">
              <a href={EMAIL_SETTINGS_LINK}>
                Set up your email provider in advanced settings
              </a>
            </p>
          </div>
          <span class="btn btn--disabled">Send to {recipients}</span>
        </>
      )}

      <div class="prose">
        <h2>Or send from your own email app</h2>
        <p>
          This opens your email app with everyone in BCC. It needs no provider
          setup, but sending lots of mail this way, especially marketing, is a
          quick way to get your account rate-limited or blocked. It's best for
          small, genuinely transactional messages.
        </p>
        <p>
          <a href={state.mailtoLink}>Open a BCC draft to {recipients}</a>
        </p>
      </div>

      {state.sendableEmails.length > 0 && (
        <>
          <div class="prose">
            <h2>Copy the address list</h2>
            <p>
              Every address that will be emailed, separated by commas. Copy
              these into your own email tool if you'd rather send another way.
            </p>
          </div>
          <label>
            Recipient addresses
            <textarea class="recipient-emails" readonly>
              {state.sendableEmails.join(", ")}
            </textarea>
          </label>
        </>
      )}
    </Layout>,
  );
};
