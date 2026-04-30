/**
 * Group selector for event forms (only shown when groups exist)
 */

import type { Group } from "#shared/types.ts";

interface EventGroupSelectProps {
  groups: Group[];
  selectedGroupId: number;
}

export const EventGroupSelect = ({
  groups,
  selectedGroupId,
}: EventGroupSelectProps): JSX.Element | null => {
  if (groups.length === 0) return null;

  return (
    <label>
      Group
      <select id="group_id" name="group_id">
        <option selected={selectedGroupId === 0} value="0">
          No Group
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
