/**
 * Admin group management routes - accessible to owners and managers
 */

import { map } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { loadAttendeeQuestionData } from "#shared/db/questions.ts";
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import { getAttendeesByEventIds, getEvent } from "#shared/db/events.ts";
import {
  assignEventsToGroup,
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  getEventsByGroupId,
  getUngroupedEvents,
  groupsTable,
  isGroupSlugTaken,
  resetGroupEvents,
  validateGroupEventType,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { settings } from "#shared/db/settings.ts";
import { GROUP_DEMO_FIELDS, wrapResourceForDemo } from "#shared/demo.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { generateUniqueSlug, normalizeSlug } from "#shared/slug.ts";
import { sortEvents } from "#shared/sort-events.ts";
import { type Attendee, type Group, isPaidEvent } from "#shared/types.ts";
import {
  adminGroupDeletePage,
  adminGroupDetailPage,
  adminGroupEditPage,
  adminGroupNewPage,
  adminGroupsPage,
} from "#templates/admin/groups.tsx";
import {
  type GroupCreateFormValues,
  type GroupFormValues,
  groupCreateFields,
  groupFields,
} from "#templates/fields.ts";
import { withEntityLoader } from "./entity-handlers.ts";

/** Generate a unique group slug, retrying on collision */
export const generateUniqueGroupSlug = () =>
  generateUniqueSlug(computeGroupSlugIndex, isGroupSlugTaken);

/** Validate that a group's slug is not already in use */
export const validateGroupSlug = async (
  input: GroupInput,
  id?: number,
): Promise<string | null> => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? "Slug is already in use" : null;
};

/** Shared fields from group form values */
const sharedGroupFields = (values: GroupCreateFormValues) => ({
  description: values.description,
  hidden: values.hidden === "1",
  maxAttendees: values.max_attendees ?? 0,
  name: values.name,
  termsAndConditions: values.terms_and_conditions,
});

/** Extract group input from create form values (auto-generates slug) */
const extractGroupCreateInput = async (
  values: GroupCreateFormValues,
): Promise<GroupInput> => {
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  return { ...sharedGroupFields(values), slug, slugIndex };
};

/** Extract group input from edit form values (uses provided slug) */
const extractGroupEditInput = async (
  values: GroupFormValues,
): Promise<GroupInput> => {
  const slug = normalizeSlug(values.slug);
  return {
    ...sharedGroupFields(values),
    slug,
    slugIndex: await computeGroupSlugIndex(slug),
  };
};

/** Delete a group and reset its events to ungrouped */
export const deleteGroup = async (
  id: Parameters<typeof groupsTable.findById>[0],
) => {
  await resetGroupEvents(Number(id));
  await groupsTable.deleteById(id);
};

/** Shared CRUD handler config */
const crudConfig = {
  getAll: getAllGroups,
  getName: (g: Group) => g.name,
  getRowPath: (g: Group) => `/admin/groups/${g.id}`,
  listPath: "/admin/groups",
  renderDelete: adminGroupDeletePage,
  renderEdit: adminGroupEditPage,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  singular: "Group",
} as const;

/** Groups resource for REST create operations (auto-generated slug) */
const groupsCreateResource = defineNamedResource({
  fields: groupCreateFields,
  nameField: "name",
  onDelete: deleteGroup,
  table: groupsTable,
  toInput: extractGroupCreateInput,
});

/** Groups resource for REST update operations (user-provided slug) */
const groupsResource = defineNamedResource({
  fields: groupFields,
  nameField: "name",
  onDelete: deleteGroup,
  table: groupsTable,
  toInput: extractGroupEditInput,
  validate: validateGroupSlug,
});

const crudCreate = createCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsCreateResource, GROUP_DEMO_FIELDS),
});
const crud = createCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});

/** Look up group by id, return 404 if not found */
export const withGroup = withEntityLoader(groupsTable.findById);

/**
 * POST handler factory: CSRF-validated form + loaded group.
 * Callers receive the group and the parsed form; a missing session or
 * missing group short-circuits with the appropriate response.
 */
export const groupFormPost = (
  handler: (group: Group, form: FormParams) => Response | Promise<Response>,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  createAuthedHandler<{ id: number }, Group>({
    handle: ({ context, form }) => handler(context, form),
    loadContext: ({ id }) => groupsTable.findById(id),
  });

/** Handle GET /admin/groups/:id - group detail page */
const handleGroupDetail: TypedRouteHandler<"GET /admin/groups/:id"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) =>
    withGroup(id)(async (group) => {
      const [events, ungroupedEvents, holidays] = await Promise.all([
        getEventsByGroupId(id),
        getUngroupedEvents(),
        getActiveHolidays(),
      ]);
      const sortedEvents = sortEvents(events, holidays);
      const eventIds = map((e: { id: number }) => e.id)(sortedEvents);
      let attendees: Attendee[] = [];
      let phonePrefix: string | undefined;
      if (eventIds.length > 0) {
        const privateKey = await requirePrivateKey(session);
        const hasPaidEvent = sortedEvents.some(isPaidEvent);
        const [rawAttendees, prefix] = await Promise.all([
          getAttendeesByEventIds(eventIds),
          Promise.resolve(settings.phonePrefix),
        ]);
        attendees = await decryptAttendees(
          rawAttendees,
          privateKey,
          hasPaidEvent,
        );
        phonePrefix = prefix;
      }
      const allowedDomain = getEffectiveDomain();
      const successMessage = getFlash().success;
      const questionData = await loadAttendeeQuestionData(
        eventIds,
        attendees.map((a) => a.id),
      );

      return htmlResponse(
        adminGroupDetailPage(
          group,
          sortedEvents,
          sortEvents(ungroupedEvents, holidays),
          attendees,
          session,
          allowedDomain,
          phonePrefix,
          successMessage,
          questionData,
        ),
      );
    }),
  );

/** Validate that all event types match the group; returns error message or null */
const validateEventTypesForGroup = async (
  groupId: number,
  eventIds: number[],
): Promise<string | null> => {
  for (const eventId of eventIds) {
    const event = await getEvent(eventId);
    if (event) {
      const typeError = await validateGroupEventType(groupId, event.event_type);
      if (typeError) return typeError;
    }
  }
  return null;
};

/** Handle POST /admin/groups/:id/add-events - assign ungrouped events to group */
const handleAddEventsToGroup = groupFormPost(async (group, form) => {
  const eventIds = form
    .getAll("event_ids")
    .map(Number)
    .filter((n) => n > 0);
  if (eventIds.length > 0) {
    const typeError = await validateEventTypesForGroup(group.id, eventIds);
    if (typeError) {
      return redirect(`/admin/groups/${group.id}`, typeError, false);
    }
    await assignEventsToGroup(eventIds, group.id);
    await logActivity(
      `${eventIds.length} event(s) added to group '${group.name}'`,
    );
  }
  return redirect(`/admin/groups/${group.id}`, "Events added to group", true);
});

/** Group routes */
export const groupsRoutes = {
  ...crud.routes,
  // Override: create uses auto-generated slug, detail has custom page
  "GET /admin/groups/new": crudCreate.newGet,
  "POST /admin/groups": crudCreate.createPost,
  ...defineRoutes({
    "GET /admin/groups/:id": handleGroupDetail,
    "POST /admin/groups/:id/add-events": handleAddEventsToGroup,
  }),
};
