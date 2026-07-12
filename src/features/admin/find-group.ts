import { groups } from "#shared/db/groups.ts";

/** The stored group row as loaded from the table. */
type GroupRow = NonNullable<Awaited<ReturnType<typeof groups.table.findById>>>;

/** Load the group with `id` and hand it to `whenFound`. When no group has that
 * id, skip the callback and return null — so a caller writes the found-group
 * path once instead of repeating the "look it up, bail if missing" load. */
export const withGroupOrNull = async <T>(
  id: number,
  whenFound: (group: GroupRow) => T | Promise<T>,
): Promise<T | null> => {
  const group = await groups.table.findById(id);
  return group ? whenFound(group) : null;
};
