/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAuth which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { groupApiRoutes } from "#routes/admin/api-groups.ts";
import { holidayApiRoutes } from "#routes/admin/api-holidays.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  computeSlugIndex,
  type EventInput,
  eventsTable,
  getAllEvents,
  getEventWithCount,
} from "#shared/db/events.ts";
import {
  generateUniqueEventSlug,
  performEventDelete,
  toggleEventActive,
  validateEventInput,
} from "#shared/events-actions.ts";
import {
  apiErrorResponse,
  type DeleteBody,
  defineCrudApi,
  type ParseResult,
  parseUpdateName,
  parseUpdateSlug,
  withApiEntity,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type {
  AdminEvent,
  Event,
  EventType,
  EventWithCount,
} from "#shared/types.ts";

// =============================================================================
// Published API types — the contract for callers
// =============================================================================

/** JSON body accepted by POST /api/admin/events */
export type CreateEventBody = {
  name: string;
  max_attendees: number;
  max_price?: number;
  description?: string;
  date?: string | null;
  location?: string;
  group_id?: number;
  unit_price?: number;
  max_quantity?: number;
  thank_you_url?: string;
  webhook_url?: string;
  active?: boolean;
  fields?: string;
  closes_at?: string | null;
  event_type?: EventType;
  bookable_days?: string[];
  minimum_days_before?: number;
  maximum_days_after?: number;
  duration_days?: number;
  non_transferable?: boolean;
  can_pay_more?: boolean;
  hidden?: boolean;
};

/** JSON body accepted by PUT /api/admin/events/:eventId (all fields optional) */
export type UpdateEventBody = Partial<CreateEventBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/events/:eventId */
export type DeleteEventBody = DeleteBody;

// =============================================================================
// Schema-driven field extraction
// =============================================================================

/** Field type tag for runtime checking */
type FieldType = "string" | "number" | "boolean" | "string[]";

/** The possible value types for event fields */
type FieldValue = string | number | boolean | string[];

/** Partial EventInput fields keyed by camelCase name */
type FieldRecord = Record<string, FieldValue>;

/**
 * Field mapping: [apiKey, eventInputKey, type]
 *
 * Single source of truth for the snake_case → camelCase mapping.
 * Drives both bodyToCreateInput (extract from JSON body) and
 * bodyToUpdateInput (defaults from existing event).
 */
type FieldMapping = readonly [string, string, FieldType];

const optionalFields: FieldMapping[] = [
  ["description", "description", "string"],
  ["date", "date", "string"],
  ["location", "location", "string"],
  ["group_id", "groupId", "number"],
  ["unit_price", "unitPrice", "number"],
  ["max_quantity", "maxQuantity", "number"],
  ["thank_you_url", "thankYouUrl", "string"],
  ["webhook_url", "webhookUrl", "string"],
  ["active", "active", "boolean"],
  ["fields", "fields", "string"],
  ["closes_at", "closesAt", "string"],
  ["event_type", "eventType", "string"],
  ["bookable_days", "bookableDays", "string[]"],
  ["minimum_days_before", "minimumDaysBefore", "number"],
  ["maximum_days_after", "maximumDaysAfter", "number"],
  ["duration_days", "durationDays", "number"],
  ["non_transferable", "nonTransferable", "boolean"],
  ["can_pay_more", "canPayMore", "boolean"],
  ["hidden", "hidden", "boolean"],
];

/** Check whether a value matches the expected field type */
const matchesType = (val: unknown, type: FieldType): val is FieldValue =>
  type === "string"
    ? typeof val === "string"
    : type === "number"
      ? typeof val === "number"
      : type === "boolean"
        ? typeof val === "boolean"
        : Array.isArray(val);

/**
 * Extract typed fields from a JSON body using field mappings.
 * Skips fields that are missing or have the wrong type.
 * Null values are included as empty strings (explicit clear).
 */
const pickTypedFields = (
  body: Record<string, unknown>,
  fields: FieldMapping[],
): FieldRecord => {
  const result: FieldRecord = {};
  for (const [apiKey, outKey, type] of fields) {
    const val = body[apiKey];
    if (val === undefined) continue;
    if (val === null) {
      result[outKey] = "";
      continue;
    }
    if (matchesType(val, type)) result[outKey] = val;
  }
  return result;
};

/**
 * Build EventInput defaults from an existing event (for updates).
 * Maps snake_case Event fields to camelCase EventInput keys.
 */
const existingToDefaults = (existing: EventWithCount): FieldRecord => {
  const result: FieldRecord = {};
  for (const [apiKey, outKey] of optionalFields) {
    const val = existing[apiKey as keyof EventWithCount];
    result[outKey] = val === null ? "" : val;
  }
  return result;
};

// =============================================================================
// Body → EventInput converters
// =============================================================================

/** Convert JSON body to EventInput for create (auto-generates slug) */
export const bodyToCreateInput = async (
  body: Record<string, unknown>,
): Promise<ParseResult<EventInput>> => {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return { error: "name is required", ok: false };
  }
  if (typeof body.max_attendees !== "number" || body.max_attendees < 1) {
    return { error: "max_attendees is required and must be >= 1", ok: false };
  }

  const { slug, slugIndex } = await generateUniqueEventSlug();

  return {
    input: {
      ...pickTypedFields(body, optionalFields),
      maxAttendees: body.max_attendees,
      maxPrice: typeof body.max_price === "number" ? body.max_price : 0,
      name: body.name.trim(),
      slug,
      slugIndex,
    } as EventInput,
    ok: true,
  };
};

/** Convert JSON body to EventInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  existing: EventWithCount,
): Promise<ParseResult<EventInput>> => {
  const parsedName = parseUpdateName(body, existing.name);
  if (!parsedName.ok) return parsedName;

  const maxAttendees =
    typeof body.max_attendees === "number"
      ? body.max_attendees
      : existing.max_attendees;
  if (maxAttendees < 1) {
    return { error: "max_attendees must be >= 1", ok: false };
  }

  const { slug, slugIndex } = await parseUpdateSlug(
    body,
    existing.slug,
    normalizeSlug,
    computeSlugIndex,
  );

  return {
    input: {
      ...existingToDefaults(existing),
      ...pickTypedFields(body, optionalFields),
      maxAttendees,
      maxPrice:
        typeof body.max_price === "number"
          ? body.max_price
          : existing.max_price,
      name: parsedName.name,
      slug,
      slugIndex,
    } as EventInput,
    ok: true,
  };
};

// =============================================================================
// Custom routes (delete with cleanup, activate/deactivate)
// =============================================================================

const withEvent = (
  request: Request,
  eventId: number,
  handler: (
    event: EventWithCount,
    body: Record<string, unknown>,
  ) => Promise<Response>,
): Promise<Response> =>
  withApiEntity(
    request,
    getEventWithCount,
    eventId,
    "Event",
    (event, _session, body) => handler(event, body),
  );

/** Custom DELETE handler: performEventDelete handles storage cleanup + logging with counts */
const handleDeleteEvent: RouteHandlerFn = (request, { eventId }) =>
  withEvent(request, eventId as number, async (event, body) => {
    const error = verifyIdentifierOrJsonError(
      event.name,
      body.confirm_identifier,
      "Event name",
    );
    if (error) return apiErrorResponse(error);
    await performEventDelete(event);
    return jsonResponse({ status: "ok" });
  });

/** Toggle event active/inactive state */
const handleToggleActive = (
  request: Request,
  eventId: number,
  active: boolean,
): Promise<Response> =>
  withEvent(request, eventId, async (event) => {
    const updated = await toggleEventActive(eventId, event, active);
    if (!updated) {
      return apiErrorResponse(
        `Event is already ${active ? "active" : "deactivated"}`,
      );
    }
    return jsonResponse({ event: toAdminEvent(updated) });
  });

/** Strip slug_index from event row, producing the admin API shape */
export const toAdminEvent = ({
  slug_index: _,
  ...rest
}: EventWithCount): AdminEvent => rest;

const eventApiRoutes = defineCrudApi<Event, EventInput, EventWithCount>({
  extraRoutes: {
    "DELETE /api/admin/events/:eventId": handleDeleteEvent,
    "POST /api/admin/events/:eventId/deactivate": (request, { eventId }) =>
      handleToggleActive(request, eventId as number, false),
    "POST /api/admin/events/:eventId/reactivate": (request, { eventId }) =>
      handleToggleActive(request, eventId as number, true),
  },
  getAll: getAllEvents,
  linkActivityToRow: true,
  listExtras: (session) => ({ admin_level: session.adminLevel }),
  lookup: getEventWithCount,
  name: "events",
  nameField: "name",
  singular: "Event",
  stripKeys: ["slug_index"],
  table: eventsTable,
  toCreateInput: bodyToCreateInput,
  toUpdateInput: bodyToUpdateInput,
  validate: validateEventInput,
});

export const adminApiRoutes = {
  ...holidayApiRoutes,
  ...groupApiRoutes,
  ...eventApiRoutes,
};
