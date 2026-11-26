/** The mark beside a required field's label. The visible star is decoration.
 *  The hidden word names the requirement for a screen reader. */

import { t } from "#i18n";

export const RequiredMark = ({
  required,
}: {
  required?: boolean | undefined;
}): JSX.Element | null =>
  required ? (
    <>
      <span aria-hidden="true" class="field-requirement">
        *
      </span>
      <span class="visually-hidden">{t("form.required")}</span>
    </>
  ) : null;
