/**
 * A yes/no radio toggle rendered as a `<fieldset class="radios">` of two
 * radios (`value="true"` / `value="false"`) backed by a boolean state.
 *
 * Used by the show-public-api and external-order settings
 * forms, which all share the exact same `common.yes`/`common.no` pair.
 * Composed from two `RadioOption`s so the per-option shape can't drift from
 * the standalone radio component.
 */

import { t } from "#i18n";
import { RadioOption } from "#templates/components/radio-option.tsx";

export const YesNoRadios = ({
  name,
  on,
}: {
  name: string;
  on: boolean;
}): JSX.Element => (
  <fieldset class="radios">
    <RadioOption checked={on === true} name={name} value="true">
      {t("common.yes")}
    </RadioOption>
    <RadioOption checked={on !== true} name={name} value="false">
      {t("common.no")}
    </RadioOption>
  </fieldset>
);
