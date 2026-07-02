/**
 * Group selector for listing forms (only shown when groups exist)
 */

import { t } from "#i18n";
import type { Group } from "#shared/types.ts";

interface ListingGroupSelectProps {
  groups: Group[];
  selectedGroupIds: number[];
}

/** Group membership editor on the listing form: a checkbox per group, so a
 * listing can belong to several groups at once (the listing-side mirror of the
 * group form's listing checkboxes). Membership is written to group_listings. */
export const ListingGroupSelect = ({
  groups,
  selectedGroupIds,
}: ListingGroupSelectProps): JSX.Element | null => {
  if (groups.length === 0) return null;
  const selected = new Set(selectedGroupIds);

  return (
    <fieldset class="checkboxes">
      <legend>{t("terms.group")}</legend>
      {groups.map((g) => (
        <label>
          <input
            checked={selected.has(g.id) || undefined}
            name="group_ids"
            type="checkbox"
            value={String(g.id)}
          />
          {` ${g.name}`}
        </label>
      ))}
    </fieldset>
  );
};
