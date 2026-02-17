/**
 * Group selector for event forms (only shown when groups exist)
 */

import type { Group } from "#lib/types.ts";

interface EventGroupSelectProps {
  groups: Group[];
  selectedGroupId: number;
}

export const EventGroupSelect = (
  { groups, selectedGroupId }: EventGroupSelectProps,
): JSX.Element | null => {
  if (groups.length === 0) return null;

  return (
    <label>
      Group
      <select name="group_id" id="group_id">
        <option value="0" selected={selectedGroupId === 0}>No Group</option>
        {groups.map((g) => (
          <option value={String(g.id)} selected={g.id === selectedGroupId}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
};
