/**
 * Shared subject/html/text fields for the email-template settings forms.
 *
 * The admin-notification and confirmation forms render an identical
 * subject + html_body + plain_text_body triple, differing only by the
 * template `kind` (which keys the id, data-default-tpl, data-fill-default
 * and the DEFAULT_TEMPLATES entry). This module factors that shape out so
 * the two forms can't drift.
 */

import { t } from "#i18n";
import { TextField } from "#templates/components/text-field.tsx";
import type { EmailContent } from "#templates/email/shared.ts";
import type { EmailTemplateType } from "#types";

/** A textarea body field (html or text), with its "edit default" link. */
const BodyField = ({
  id,
  bodyKind,
  defaultValue,
  value,
  rows,
}: {
  id: string;
  bodyKind: "html" | "text";
  defaultValue: string;
  value: string;
  rows: number;
}): JSX.Element => (
  <>
    <label>
      {bodyKind === "html"
        ? t("settings.advanced.html_body")
        : t("settings.advanced.plain_text_body")}
      <textarea
        data-default-tpl={defaultValue}
        id={id}
        name={bodyKind}
        placeholder={t("settings.advanced.leave_blank_default")}
        rows={`${rows}`}
      >
        {value}
      </textarea>
    </label>
    <a data-fill-default={id} href="#">
      <small>{t("settings.advanced.edit_default_template")}</small>
    </a>
  </>
);

/**
 * Render the subject + html body + plain-text body fields for one template
 * kind. Curried by `kind` so the call site passes only the stored values.
 */
export const emailTemplateFields =
  (kind: EmailTemplateType) =>
  (templates: EmailContent, defaults: EmailContent): JSX.Element => (
    <>
      <TextField
        label={t("settings.advanced.subject")}
        name="subject"
        placeholder={defaults.subject}
        type="text"
        value={templates.subject}
      />
      <BodyField
        bodyKind="html"
        defaultValue={defaults.html}
        id={`${kind}_html`}
        rows={8}
        value={templates.html}
      />
      <BodyField
        bodyKind="text"
        defaultValue={defaults.text}
        id={`${kind}_text`}
        rows={6}
        value={templates.text}
      />
      <br />
    </>
  );
