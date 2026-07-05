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
import { CsrfForm, hiddenInputs } from "#shared/forms.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import { ProsePanel } from "#templates/components/prose-panel.tsx";
import { rawParagraph } from "#templates/components/raw-paragraph.tsx";
import { SelectField } from "#templates/components/select-field.tsx";

const NAV_ACTIVE = "/admin/settings";

/** Deep link to the Email Notifications form on the advanced settings page. */
const EMAIL_SETTINGS_LINK = "/admin/settings-advanced#settings-email";

/** Wrap a bulk-email page body in the standard
 *  `<AdminPage active=NAV_ACTIVE title>{<div class="prose"><h1>{title}</h1></div> + body}</AdminPage>`
 *  scaffolding shared by the compose and preview pages. */
const bulkEmailPage = (
  session: AdminSession,
  title: string,
  body: Child,
): string =>
  String(
    <AdminPage active={NAV_ACTIVE} session={session} title={title}>
      <ProseHeading heading={title} />
      {body}
    </AdminPage>,
  );

/** "Email provider setup" deep link paragraph: appeared duplicated inside
 *  the compose and preview unavailability notices. */
const SetupEmailProviderLink = (): JSX.Element => (
  <p class="small">
    <a href={EMAIL_SETTINGS_LINK}>{t("bulk_email.setup_email_provider")}</a>
  </p>
);

/** "Provider sending is unavailable on the preview page" notice — the
 *  `sending_disabled` heading + reason + setup link. Used only on the
 *  preview page (the compose page's notice carries different copy). */
const ProviderUnavailableNotice = ({
  reason,
}: {
  reason: string;
}): JSX.Element => (
  <ProsePanel label={`${t("bulk_email.sending_disabled")}.`} value={reason}>
    <SetupEmailProviderLink />
  </ProsePanel>
);

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
  /** Saved templates available to load (decrypted subjects). */
  templates: { id: number; subject: string }[];
  /** Which template is currently loaded (null = using a saved draft). */
  selectedTemplateId: number | null;
  /** Base URL for template load links (includes target query params). */
  templateLinkBase: string;
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
        <SelectField
          name={control.name}
          options={control.options.map((option) => ({
            label: option.label,
            value: option.value,
          }))}
          value={control.selected}
        />
      </label>
    );
  }
  return (
    <>
      {hiddenInputs(control.fields)}
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
  const { copy, draft, single, templateLinkBase } = state;
  return bulkEmailPage(
    session,
    copy.heading,
    <>
      <div class="prose">
        <p>{copy.intro}</p>
      </div>

      {!state.canBulkSend && (
        <div class="prose">
          <p>
            <strong>{t("bulk_email.heads_up")}:</strong> {state.disabledReason}{" "}
            {t("bulk_email.compose_preview_fallback")}
          </p>
          <SetupEmailProviderLink />
        </div>
      )}

      {state.templates.length > 0 && (
        <details>
          <summary>{t("bulk_email.load_template_summary")}</summary>
          <div class="prose">
            <ul>
              {state.templates.map((tpl) => (
                <li>
                  <a href={`${templateLinkBase}&template=${tpl.id}`}>
                    {tpl.subject}
                  </a>
                  {state.selectedTemplateId === tpl.id &&
                    ` ${t("bulk_email.template_loaded_marker")}`}{" "}
                  <a
                    class="danger small"
                    href={`/admin/emails/templates/${tpl.id}/delete`}
                  >
                    {t("common.delete")}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </details>
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

        {state.templates.length > 0 && (
          <fieldset class="checkboxes">
            <label>
              <input name="update_existing" type="checkbox" value="1" />{" "}
              {t("bulk_email.update_existing_checkbox")}
            </label>
          </fieldset>
        )}

        {state.templates.length > 0 && (
          <div class="template-update-fields">
            <label>
              {t("bulk_email.template_to_update_label")}
              <SelectField
                name="template_id"
                options={state.templates.map((tpl) => ({
                  label: tpl.subject,
                  value: String(tpl.id),
                }))}
                value={String(state.selectedTemplateId)}
              />
            </label>
          </div>
        )}

        <button formaction="/admin/emails/templates" type="submit">
          <span class="save-as-new">
            {t("bulk_email.save_as_new_template")}
          </span>
          <span class="save-update">
            {t("bulk_email.update_template_button")}
          </span>
        </button>
      </CsrfForm>
    </>,
  );
};

/**
 * Confirmation page for deleting a saved bulk-email template. The owner must
 * re-type the template's subject, matching the typed-identifier delete flow used
 * for other named resources.
 */
export const bulkEmailTemplateDeletePage = (
  session: AdminSession,
  template: { id: number; subject: string },
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/emails/templates/${template.id}/delete`,
    active: NAV_ACTIVE,
    buttonText: t("bulk_email.delete_template_submit"),
    children: (
      <>
        <p>
          {t("bulk_email.delete_template_intro")}{" "}
          <strong>{template.subject}</strong>
        </p>
        <p>{t("bulk_email.delete_template_prompt")}</p>
      </>
    ),
    error,
    heading: t("bulk_email.delete_template_heading"),
    label: t("bulk_email.subject_label"),
    name: template.subject,
    session,
    title: t("bulk_email.delete_template_heading"),
  });

export type BulkEmailPreviewState = {
  draft: BulkEmailDraft;
  /** Human label for the target: audience label or listing name. */
  targetLabel: string;
  /** Audience description (omitted for single-listing sends). */
  audienceDescription?: string | undefined;
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
  marketing
    ? rawParagraph("bulk_email.marketing_email_explainer")
    : rawParagraph("bulk_email.transactional_email_explainer");

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
  return bulkEmailPage(
    session,
    t("bulk_email.preview_page_title"),
    <>
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
          <ProviderUnavailableNotice reason={state.disabledReason} />
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
    </>,
  );
};
