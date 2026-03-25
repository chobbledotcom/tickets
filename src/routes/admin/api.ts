/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAdminApi which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { map } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  computeSlugIndex,
  type EventInput,
  eventsTable,
  getAllEvents,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import {
  generateUniqueEventSlug,
  performEventDelete,
  toggleEventActive,
  validateEventInput,
} from "#lib/events-actions.ts";
import { normalizeSlug } from "#lib/slug.ts";
import type {
  AdminEvent,
  AdminSession,
  EventType,
  EventWithCount,
} from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import { jsonResponse, withAdminApi } from "#routes/utils.ts";

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
  non_transferable?: boolean;
  can_pay_more?: boolean;
  hidden?: boolean;
};

/** JSON body accepted by PUT /api/admin/events/:eventId (all fields optional) */
export type UpdateEventBody = Partial<CreateEventBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/events/:eventId */
export type DeleteEventBody = { confirm_name: string };

// =============================================================================
// Schema-driven field extraction
// =============================================================================

/** Field type tag for runtime checking */
type FieldType = "string" | "number" | "boolean" | "string[]";

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
  ["non_transferable", "nonTransferable", "boolean"],
  ["can_pay_more", "canPayMore", "boolean"],
  ["hidden", "hidden", "boolean"],
];

/** Check whether a value matches the expected field type */
const matchesType = (val: unknown, type: FieldType): boolean =>
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
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
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
const existingToDefaults = (
  existing: EventWithCount,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [apiKey, outKey] of optionalFields) {
    const val = existing[apiKey as keyof EventWithCount];
    result[outKey] = val === null ? "" : val;
  }
  return result;
};

// =============================================================================
// Body → EventInput converters
// =============================================================================

/** Strip internal fields from an event, returning the admin API shape */
export const toAdminEvent = ({
  slug_index: _,
  ...event
}: EventWithCount): AdminEvent => event;

/** Error response helper */
const errorResponse = (message: string, status = 400): Response =>
  jsonResponse({ status: "error", message }, status);

/** Result type for body parsing */
type BodyParseResult =
  | { ok: true; input: EventInput }
  | { ok: false; error: string };

/**
 * Auth + event lookup helper.
 * Calls withAdminApi, fetches the event, and passes it to the callback.
 * Returns 404 automatically if the event doesn't exist.
 */
const withEventApi = (
  request: Request,
  eventId: number,
  handler: (
    event: EventWithCount,
    session: AdminSession,
    body: Record<string, unknown>,
  ) => Promise<Response>,
): Promise<Response> =>
  withAdminApi(request, async (session, body) => {
    const event = await getEventWithCount(eventId);
    if (!event) return errorResponse("Event not found", 404);
    return handler(event, session, body);
  });

/** Convert JSON body to EventInput for create (auto-generates slug) */
export const bodyToCreateInput = async (
  body: Record<string, unknown>,
): Promise<BodyParseResult> => {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return { ok: false, error: "name is required" };
  }
  if (typeof body.max_attendees !== "number" || body.max_attendees < 1) {
    return { ok: false, error: "max_attendees is required and must be >= 1" };
  }

  const { slug, slugIndex } = await generateUniqueEventSlug();

  return {
    ok: true,
    input: {
      ...pickTypedFields(body, optionalFields),
      name: body.name.trim(),
      slug,
      slugIndex,
      maxAttendees: body.max_attendees,
      maxPrice: typeof body.max_price === "number" ? body.max_price : 0,
    } as EventInput,
  };
};

/** Convert JSON body to EventInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  existing: EventWithCount,
): Promise<BodyParseResult> => {
  const name = body.name != null ? String(body.name).trim() : existing.name;
  if (name === "") return { ok: false, error: "name cannot be empty" };

  const maxAttendees =
    typeof body.max_attendees === "number"
      ? body.max_attendees
      : existing.max_attendees;
  if (maxAttendees < 1) {
    return { ok: false, error: "max_attendees must be >= 1" };
  }

  const rawSlug =
    body.slug != null ? normalizeSlug(String(body.slug)) : existing.slug;
  const slugIndex = await computeSlugIndex(rawSlug);

  return {
    ok: true,
    input: {
      ...existingToDefaults(existing),
      ...pickTypedFields(body, optionalFields),
      name,
      slug: rawSlug,
      slugIndex,
      maxAttendees,
      maxPrice:
        typeof body.max_price === "number"
          ? body.max_price
          : existing.max_price,
    } as EventInput,
  };
};

// =============================================================================
// Route handlers
// =============================================================================

/** GET /api/admin/events — list all events with counts */
const handleListEvents = (request: Request): Promise<Response> =>
  withAdminApi(request, async (session) => {
    const events = await getAllEvents();
    return jsonResponse({
      events: map(toAdminEvent)(events),
      admin_level: session.adminLevel,
    });
  });

/** Toggle event active/inactive state */
const handleToggleActive = (
  request: Request,
  eventId: number,
  active: boolean,
): Promise<Response> =>
  withEventApi(request, eventId, async (event) => {
    const updated = await toggleEventActive(eventId, event, active);
    if (!updated)
      return errorResponse(
        `Event is already ${active ? "active" : "deactivated"}`,
      );
    return jsonResponse({ event: toAdminEvent(updated) });
  });

/** POST /api/admin/events — create event */
const handleCreateEvent = (request: Request): Promise<Response> =>
  withAdminApi(request, async (_session, body) => {
    const parsed = await bodyToCreateInput(body);
    if (!parsed.ok) return errorResponse(parsed.error);

    const validationError = await validateEventInput(parsed.input);
    if (validationError) return errorResponse(validationError);

    const row = await eventsTable.insert(parsed.input);
    const event = await getEventWithCount(row.id);
    await logActivity(`Event '${row.name}' created`, row);
    return jsonResponse({ event: toAdminEvent(event!) }, 201);
  });

export const adminApiRoutes = defineRoutes({
  "GET /api/admin/events": handleListEvents,
  "GET /api/admin/events/:eventId": (request, { eventId }) =>
    withEventApi(request, eventId, (event) =>
      Promise.resolve(jsonResponse({ event: toAdminEvent(event) })),
    ),
  "POST /api/admin/events": handleCreateEvent,
  "PUT /api/admin/events/:eventId": (request, { eventId }) =>
    withEventApi(request, eventId, async (existing, _session, body) => {
      const parsed = await bodyToUpdateInput(body, existing);
      if (!parsed.ok) return errorResponse(parsed.error);

      if (parsed.input.slug !== existing.slug) {
        const taken = await isSlugTaken(parsed.input.slug, eventId);
        if (taken)
          return errorResponse("Slug is already in use by another event");
      }

      const validationError = await validateEventInput(parsed.input, eventId);
      if (validationError) return errorResponse(validationError);

      const row = (await eventsTable.update(eventId, parsed.input))!;
      const updated = await getEventWithCount(row.id);
      await logActivity(`Event '${row.name}' updated`, row);
      return jsonResponse({ event: toAdminEvent(updated!) });
    }),
  "DELETE /api/admin/events/:eventId": (request, { eventId }) =>
    withEventApi(request, eventId, async (event, _session, body) => {
      const confirmName =
        typeof body.confirm_name === "string" ? body.confirm_name.trim() : "";
      if (confirmName.toLowerCase() !== event.name.trim().toLowerCase()) {
        return errorResponse(
          "Event name does not match. Please provide the exact event name in confirm_name.",
        );
      }

      await performEventDelete(event);
      return jsonResponse({ status: "ok" });
    }),
  "POST /api/admin/events/:eventId/deactivate": (request, { eventId }) =>
    handleToggleActive(request, eventId, false),
  "POST /api/admin/events/:eventId/reactivate": (request, { eventId }) =>
    handleToggleActive(request, eventId, true),
});
