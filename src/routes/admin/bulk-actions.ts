/**
 * Bulk actions for groups.
 *
 * Provides a landing page listing available bulk operations for a group's
 * events, and per-action form + handler pairs. The first action is
 * "Duplicate Group": create a new group and clone every event into it,
 * applying a shared find/replace on the event name and a date shift
 * derived from two reference dates.
 */

import {
  applyNameReplacement,
  computeDayOffset,
  shiftUtcIsoByDays,
} from "#lib/bulk-replace.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { eventsTable } from "#lib/db/events.ts";
import { getEventsByGroupId, groupsTable } from "#lib/db/groups.ts";
import { buildDuplicateEventInput } from "#lib/events-actions.ts";
import { sortEvents } from "#lib/sort-events.ts";
import type { AdminSession, EventWithCount, Group } from "#lib/types.ts";
import {
  generateUniqueGroupSlug,
  groupFormPost,
  withGroup,
} from "#routes/admin/groups.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  errorRedirect,
  htmlResponse,
  redirect,
  requireSessionOr,
} from "#routes/utils.ts";
import {
  adminBulkActionsPage,
  adminDuplicateGroupPage,
} from "#templates/admin/bulk-actions.tsx";

/** Render a bulk-actions sub-page for an authenticated group detail view. */
const groupEventsPage =
  (
    render: (
      group: Group,
      events: EventWithCount[],
      session: AdminSession,
    ) => string,
  ): TypedRouteHandler<"GET /admin/groups/:id/bulk-actions"> =>
  (request, { id }) =>
    requireSessionOr(request, (session) =>
      withGroup(id, async (group) => {
        const events = sortEvents(await getEventsByGroupId(group.id), []);
        return htmlResponse(render(group, events, session));
      }),
    );

/** GET /admin/groups/:id/bulk-actions */
const handleBulkActionsGet = groupEventsPage(adminBulkActionsPage);

/** GET /admin/groups/:id/bulk-actions/duplicate */
const handleDuplicateGroupGet = groupEventsPage(adminDuplicateGroupPage);

/** POST /admin/groups/:id/bulk-actions/duplicate */
const handleDuplicateGroupPost = groupFormPost(async (group, form) => {
  const formUrl = `/admin/groups/${group.id}/bulk-actions/duplicate`;
  const newName = form.getString("new_name").trim();
  if (!newName) {
    return errorRedirect(formUrl, "New group name is required");
  }

  const nameFind = form.getString("name_find");
  const nameReplace = form.getString("name_replace");
  const dateFind = form.getString("date_find");
  const dateReplace = form.getString("date_replace");
  const dayOffset = computeDayOffset(dateFind, dateReplace);

  const events = await getEventsByGroupId(group.id);
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  const newGroup = await groupsTable.insert({
    description: group.description,
    hidden: group.hidden,
    maxAttendees: group.max_attendees,
    name: newName,
    slug,
    slugIndex,
    termsAndConditions: group.terms_and_conditions,
  });

  for (const event of events) {
    const input = await buildDuplicateEventInput(event, {
      closesAt: shiftUtcIsoByDays(event.closes_at ?? "", dayOffset),
      date: shiftUtcIsoByDays(event.date, dayOffset),
      groupId: newGroup.id,
      name: applyNameReplacement(event.name, nameFind, nameReplace),
    });
    await eventsTable.insert(input);
  }

  await logActivity(
    `Group '${group.name}' duplicated to '${newGroup.name}' with ${events.length} event(s)`,
  );

  return redirect(
    `/admin/groups/${newGroup.id}`,
    `Duplicated '${group.name}' to '${newGroup.name}' (${events.length} event(s))`,
    true,
  );
});

/** Bulk actions routes */
export const bulkActionsRoutes = defineRoutes({
  "GET /admin/groups/:id/bulk-actions": handleBulkActionsGet,
  "GET /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupGet,
  "POST /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupPost,
});
