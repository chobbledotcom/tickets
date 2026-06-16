/**
 * Admin bulk email templates — compose and preview pages.
 */

import { t } from "#i18n";
import {
  type BulkEmailDraft,
  type ComposeControl,
  type ComposeCopy,
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
  /** How to render the recipient control (spec-driven: selector or fixed). */
  control: ComposeControl;
  /** Heading + intro for this kind of target (spec-driven). */
  copy: ComposeCopy;
  /** Human label for a fixed target (listing name / attendee address); unused
   * for the audience selector. */
  targetLabel: string;
  /** Whether the target is a single person (tunes the page's wording). */
  single: boolean;
  recipientCount: number;
  canBulkSend: boolean;
  /** Why provider sending is unavailable ("" when it is available). */
  disabledReason: string;
  /** Existing saved draft, used to repopulate the form. */
  draft: BulkEmailDraft | null;
};

/**
 * The recipient control at the top of the compose form, rendered from the
 * target's spec-declared {@link ComposeControl}: a `select` chooser (you can
 * change the value) or a `fixed` target (hidden inputs + a label). The template
 * never branches on the target's kind, so a new kind needs no change here.
 */
const TargetField = ({
  state,
}: {
  state: BulkEmailComposeState;
}): JSX.Element => {
  const { control } = state;
  if (control.mode === "select") {
    return (
      <label>
        {control.label}
        <select name={control.name}>
          {control.options.map((option) => (
            <option
              selected={option.value === control.selected}
              value={option.value}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <>
      {control.fields.map(([name, value]) => (
        <input name={name} type="hidden" value={value} />
      ))}
      <p>
        <strong>
          {state.single
            ? t("bulk_email.recipient_label")
            : t("bulk_email.recipients_label")}
          :
        </strong>{" "}
        {state.targetLabel}
      </p>
    </>
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
  const { copy, draft, single } = state;
  return String(
    <Layout title={copy.heading}>
      <AdminNav active={NAV_ACTIVE} session={session} />
      <Flash />

      <div class="prose">
        <h1>{copy.heading}</h1>
        <p>{copy.intro}</p>
      </div>

      {!state.canBulkSend && (
        <div class="prose">
          <p>
            <strong>{t("bulk_email.heads_up")}:</strong> {state.disabledReason}{" "}
            {t("bulk_email.compose_preview_fallback")}
          </p>
          <p class="small">
            <a href={EMAIL_SETTINGS_LINK}>
              {t("bulk_email.setup_email_provider")}
            </a>
          </p>
        </div>
      )}

      <CsrfForm action="/admin/emails/preview" id="bulk-email">
        <TargetField state={state} />

        <label>
          {t("bulk_email.subject_label")}
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
          {t("bulk_email.message_label")}
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
            {t("bulk_email.marketing_checkbox")}
          </label>
        </fieldset>

        <div class="prose">
          {single ? (
            <p>{t("bulk_email.preview_single_guidance")}</p>
          ) : (
            <p>
              {t("bulk_email.recipient_reach_intro")}{" "}
              <strong>{state.recipientCount}</strong>{" "}
              {t("bulk_email.recipient_word", {
                count: state.recipientCount,
              })}
              {t("bulk_email.recipient_reach_outro")}
            </p>
          )}
        </div>

        <button type="submit">{t("bulk_email.preview_button")}</button>
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
      <Raw html={t("bulk_email.marketing_email_explainer")} />
    </p>
  ) : (
    <p>
      <Raw html={t("bulk_email.transactional_email_explainer")} />
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
  const single = state.sendableCount === 1;
  const recipients = `${state.sendableCount} recipient${single ? "" : "s"}`;
  return String(
    <Layout title={t("bulk_email.preview_page_title")}>
      <AdminNav active={NAV_ACTIVE} session={session} />
      <Flash />

      <div class="prose">
        <h1>{t("bulk_email.preview_page_title")}</h1>
      </div>
      <p>
        <ActionButton
          href={`/admin/emails${targetQuery(draft.target)}`}
          icon="arrow-left"
          variant="secondary"
        >
          {t("bulk_email.edit_message_button")}
        </ActionButton>
      </p>

      <div class="prose">
        <p>
          <strong>{t("bulk_email.to_label")}:</strong> {state.targetLabel} (
          {recipients}
          {state.skippedCount > 0
            ? `, ${state.skippedCount} ${t("bulk_email.unsubscribed_skipped")}`
            : ""}
          )
        </p>
        {state.audienceDescription && (
          <p class="small">{state.audienceDescription}</p>
        )}
        {state.contactSummary && <p class="small">{state.contactSummary}</p>}
        <p>
          <strong>{t("bulk_email.preview_subject_label")}:</strong>{" "}
          {draft.subject}
        </p>
        <TypeExplainer marketing={draft.marketing} />
      </div>

      <div class="prose">
        <h2>{t("bulk_email.message_preview_heading")}</h2>
      </div>
      <article class="prose email-preview">
        <Raw html={renderMarkdown(draft.body)} />
      </article>
      {draft.marketing && (
        <div class="prose">
          <p class="small">{t("bulk_email.unsubscribe_footer_notice")}</p>
        </div>
      )}

      <div class="prose">
        <h2>{t("bulk_email.send_provider_heading")}</h2>
      </div>
      {state.canBulkSend ? (
        <CsrfForm
          action="/admin/emails/send"
          class="inline"
          id="bulk-email-send"
        >
          <button type="submit">
            {t("bulk_email.send_button", {
              provider: state.providerLabel,
              recipients,
            })}
          </button>
        </CsrfForm>
      ) : (
        <>
          <div class="prose">
            <p>
              <strong>{t("bulk_email.sending_disabled")}.</strong>{" "}
              {state.disabledReason}
            </p>
            <p class="small">
              <a href={EMAIL_SETTINGS_LINK}>
                {t("bulk_email.setup_email_provider")}
              </a>
            </p>
          </div>
          <span class="btn btn--disabled">
            {t("bulk_email.send_button_disabled", { recipients })}
          </span>
        </>
      )}

      <div class="prose">
        <h2>{t("bulk_email.manual_send_heading")}</h2>
        <p>
          {single
            ? t("bulk_email.manual_send_single")
            : t("bulk_email.manual_send_bulk")}{" "}
          {t("bulk_email.manual_send_warning")}
        </p>
        <p>
          <a href={state.mailtoLink}>
            {single
              ? t("bulk_email.manual_draft_single")
              : t("bulk_email.manual_draft_bulk")}
            {recipients}
          </a>
        </p>
      </div>

      {state.sendableEmails.length > 0 && (
        <>
          <div class="prose">
            <h2>{t("bulk_email.copy_addresses_heading")}</h2>
            <p>{t("bulk_email.copy_addresses_description")}</p>
          </div>
          <label>
            {t("bulk_email.recipient_addresses_label")}
            <textarea class="recipient-emails" readonly>
              {state.sendableEmails.join(", ")}
            </textarea>
          </label>
        </>
      )}
    </Layout>,
  );
};
