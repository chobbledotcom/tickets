/**
 * Group selector for listing forms (only shown when groups exist)
 */

import { t } from "#i18n";
import type { Group } from "#shared/types.ts";

interface ListingGroupSelectProps {
  groups: Group[];
  selectedGroupId: number;
}

export const ListingGroupSelect = ({
  groups,
  selectedGroupId,
}: ListingGroupSelectProps): JSX.Element | null => {
  if (groups.length === 0) return null;

  return (
    <label>
      {t("terms.group")}
      <select id="group_id" name="group_id">
        <option selected={selectedGroupId === 0} value="0">
          {t("groups.select.none")}
        </option>
        {groups.map((g) => (
          <option selected={g.id === selectedGroupId} value={String(g.id)}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
};
