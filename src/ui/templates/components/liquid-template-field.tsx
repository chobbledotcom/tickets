/**
 * One operator-editable Liquid template box, with its "start from the site's
 * own wording" link.
 *
 * Every surface that stores a template shows the same box. It holds the saved
 * text, shows the built-in default as the placeholder, and links to that
 * default. The caller supplies the field attributes, so the input and the POST
 * guard read one declaration.
 */

import { t } from "#i18n";

export const LiquidTemplateField = ({
  attributes,
  defaultValue,
  id,
  label,
  rows,
  value,
}: {
  attributes: { name: string; maxlength: number | undefined };
  /** The built-in template shown behind an empty box, and filled in by the
   * link under it. */
  defaultValue: string;
  id: string;
  label: string;
  rows: number;
  value: string;
}): JSX.Element => (
  <>
    <label>
      {label}
      <textarea
        data-default-tpl={defaultValue}
        id={id}
        {...attributes}
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
