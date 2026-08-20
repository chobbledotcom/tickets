import { getGroupById } from "#db/groups.ts";
import { type FindByIdThen, findByIdThen } from "#shared/find-by-id.ts";

/** The stored group row as loaded from the table. */
type GroupRow = NonNullable<Awaited<ReturnType<typeof getGroupById>>>;

/** Load the group with `id` and hand it to `whenFound`. When no group has that
 * id, skip the callback and return null — so a caller writes the found-group
 * path once instead of repeating the "look it up, bail if missing" load. */
export const withGroupOrNull: FindByIdThen<GroupRow> =
  findByIdThen(getGroupById);
