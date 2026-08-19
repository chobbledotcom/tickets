// deno-fmt-ignore-file

import { groups } from "#db/groups.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import type { Group } from "#types";

/** Find a group by name from the live group set. Returns `undefined` when no
 *  group with that name exists. Searches the cache rather than remembering an
 *  id at set-up, because a later step may have taken a group away and the story
 *  still needs to find the one it has now. */
export const findGroup = async (name: string): Promise<Group | undefined> =>
  (await groups.cache.getAll()).find((g) => g.name === name);

/** Find a group by name, creating it if it does not exist. Used by `Given`
 *  steps that accumulate members under the same group name across multiple
 *  lines. */
export const findOrCreateGroup = async (name: string): Promise<Group> =>
  (await findGroup(name)) ?? (await createTestGroup({ name }));

/** A group the story is talking about, found by the name the story calls it.
 *  Throws if no group with that name exists — the story must set it up first. */
export const groupNamed = async (name: string): Promise<Group> => {
  const found = await findGroup(name);
  if (!found) throw new Error(`No group called "${name}" exists`);
  return found;
};

/** Build a bulk-action URL for a group id. Curried with the action segment
 *  (`"deactivate"`, `"duplicate"`, `"reactivate"`, or `""` for the landing). */
export const bulkActionPath =
  (action: string): ((groupId: number) => string) =>
  (groupId) =>
    `/admin/groups/${groupId}/bulk-actions/${action}`;

/** The listing names each group was set up with, recorded at Given time so the
 *  `Then` steps assert on the exact listing ids the story created — not a
 *  post-action membership re-query that could silently drop a listing whose
 *  `group_listings` row a regression deleted alongside flipping `active`. */
const groupMembers = new WeakMap<TicketsWorld, Map<string, string[]>>();

export const rememberGroupMember = (
  world: TicketsWorld,
  groupName: string,
  listingName: string,
): void => {
  let members = groupMembers.get(world);
  if (!members) {
    members = new Map();
    groupMembers.set(world, members);
  }
  const names = members.get(groupName) ?? [];
  names.push(listingName);
  members.set(groupName, names);
};

/** The listing names set up for a group, in the order they were recorded. */
export const memberNamesOf = (
  world: TicketsWorld,
  groupName: string,
): string[] => {
  const names = groupMembers.get(world)?.get(groupName);
  if (!names || names.length === 0) {
    throw new Error(`No listings were set up for the "${groupName}" group`);
  }
  return names;
};

/** The listing ids set up for a group, resolved from the names the story used. */
export const memberIdsOf = (world: TicketsWorld, groupName: string): number[] =>
  memberNamesOf(world, groupName).map((name) => listingNamed(world, name).id);
