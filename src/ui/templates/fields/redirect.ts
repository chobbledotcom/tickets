/** The add-redirect form: the page that is missing, and where it goes. Built
 *  per request, so each label follows the active language. */

import { t } from "#i18n";
import { defineFieldsForm } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";

const getRedirectFields = () =>
  [
    {
      hint: t("fields.redirect.from_path_hint"),
      label: t("fields.redirect.from_path"),
      name: "fromPath",
      placeholder: t("fields.redirect.from_path_placeholder"),
      required: true,
      type: "text",
    },
    {
      hint: t("fields.redirect.to_url_hint"),
      label: t("fields.redirect.to_url"),
      name: "toUrl",
      placeholder: t("fields.redirect.to_url_placeholder"),
      required: true,
      type: "text",
    },
  ] as const satisfies readonly Field[];

export const getRedirectForm = defineFieldsForm(getRedirectFields);
