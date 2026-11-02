/**
 * Shared subject/html/text fields for the email-template settings forms.
 *
 * The admin-notification and confirmation forms render an identical
 * subject + html_body + plain_text_body triple. They differ only by the
 * template `kind`. The `kind` keys the id, data-default-tpl,
 * data-fill-default, and the DEFAULT_TEMPLATES entry. This module factors
 * that shape out so the two forms cannot drift.
 */

import { t } from "#i18n";
import {
  emailTemplateSettingsFields,
  settingsFieldAttributes,
} from "#shared/settings/fields.ts";
import { LiquidTemplateField } from "#templates/components/liquid-template-field.tsx";
import { TextField } from "#templates/components/text-field.tsx";
import type { EmailContent } from "#templates/email/shared.ts";
import type { EmailTemplateType } from "#types";

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
        {...settingsFieldAttributes(emailTemplateSettingsFields(), "subject")}
        placeholder={defaults.subject}
        type="text"
        value={templates.subject}
      />
      <LiquidTemplateField
        attributes={settingsFieldAttributes(
          emailTemplateSettingsFields(),
          "html",
        )}
        defaultValue={defaults.html}
        id={`${kind}_html`}
        label={t("settings.advanced.html_body")}
        rows={8}
        value={templates.html}
      />
      <LiquidTemplateField
        attributes={settingsFieldAttributes(
          emailTemplateSettingsFields(),
          "text",
        )}
        defaultValue={defaults.text}
        id={`${kind}_text`}
        label={t("settings.advanced.plain_text_body")}
        rows={6}
        value={templates.text}
      />
      <br />
    </>
  );
