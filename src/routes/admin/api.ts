/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAdminApi which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { map } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getAllEvents,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { groupsTable, validateGroupEventType } from "#lib/db/groups.ts";
import { generateUniqueSlug, normalizeSlug } from "#lib/slug.ts";
import { tryDeleteImage } from "#lib/storage.ts";
import type { AdminEvent, EventType, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import { jsonResponse, withAdminApi } from "#routes/utils.ts";

/** Strip internal fields from an event, returning the admin API shape */
export const toAdminEvent = ({
  slug_index: _,
  ...event
}: EventWithCount): AdminEvent => event;

/** Error response helper */
const errorResponse = (message: string, status = 400): Response =>
  jsonResponse({ status: "error", message }, status);

/** Generate a unique event slug, retrying on collision */
const generateUniqueEventSlug = (excludeEventId?: number) =>
  generateUniqueSlug(computeSlugIndex, (slug) =>
    isSlugTaken(slug, excludeEventId),
  );

/** Validate max_price is at least unit_price + 100 cents */
const validateMaxPrice = (input: EventInput): string | null => {
  const minPrice = (input.unitPrice ?? 0) + 100;
  return input.maxPrice < minPrice
    ? `Maximum price must be at least ${formatCurrency(100)} more than the ticket price`
    : null;
};

/** Validate event input (group exists, max price, etc.) */
const validateEventInput = async (
  input: EventInput,
  existingId?: number,
): Promise<string | null> => {
  if (input.canPayMore) {
    const maxPriceError = validateMaxPrice(input);
    if (maxPriceError) return maxPriceError;
  }
  if (input.groupId && input.groupId !== 0) {
    const group = await groupsTable.findById(input.groupId);
    if (!group) return "Selected group does not exist";
    const typeError = await validateGroupEventType(
      input.groupId,
      input.eventType!,
      existingId ?? 0,
    );
    if (typeError) return typeError;
  }
  return null;
};

/** Extract an optional string field from JSON body (returns undefined if null/missing) */
const optionalString = (value: unknown): string | undefined => {
  if (value == null || value === "") return undefined;
  return String(value);
};

/** Convert JSON body to EventInput for create (auto-generates slug) */
export const bodyToCreateInput = async (
  body: Record<string, unknown>,
): Promise<{ ok: true; input: EventInput } | { ok: false; error: string }> => {
  const name = body.name;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "name is required" };
  }
  const maxAttendees = body.max_attendees;
  if (typeof maxAttendees !== "number" || maxAttendees < 1) {
    return { ok: false, error: "max_attendees is required and must be >= 1" };
  }

  const { slug, slugIndex } = await generateUniqueEventSlug();

  const input: EventInput = {
    name: String(name).trim(),
    slug,
    slugIndex,
    maxAttendees,
    maxPrice: typeof body.max_price === "number" ? body.max_price : 0,
    description:
      body.description != null ? String(body.description) : undefined,
    date: optionalString(body.date),
    location: body.location != null ? String(body.location) : undefined,
    groupId: typeof body.group_id === "number" ? body.group_id : undefined,
    unitPrice:
      typeof body.unit_price === "number" ? body.unit_price : undefined,
    maxQuantity:
      typeof body.max_quantity === "number" ? body.max_quantity : undefined,
    thankYouUrl:
      body.thank_you_url != null ? String(body.thank_you_url) : undefined,
    webhookUrl: body.webhook_url != null ? String(body.webhook_url) : undefined,
    active: typeof body.active === "boolean" ? body.active : undefined,
    fields: body.fields != null ? String(body.fields) : undefined,
    closesAt: optionalString(body.closes_at),
    eventType: body.event_type as EventType | undefined,
    bookableDays: Array.isArray(body.bookable_days)
      ? body.bookable_days
      : undefined,
    minimumDaysBefore:
      typeof body.minimum_days_before === "number"
        ? body.minimum_days_before
        : undefined,
    maximumDaysAfter:
      typeof body.maximum_days_after === "number"
        ? body.maximum_days_after
        : undefined,
    nonTransferable:
      typeof body.non_transferable === "boolean"
        ? body.non_transferable
        : undefined,
    canPayMore:
      typeof body.can_pay_more === "boolean" ? body.can_pay_more : undefined,
    hidden: typeof body.hidden === "boolean" ? body.hidden : undefined,
  };

  return { ok: true, input };
};

/** Convert JSON body to EventInput for update (reads slug from body or keeps existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  existing: EventWithCount,
): Promise<{ ok: true; input: EventInput } | { ok: false; error: string }> => {
  const name = body.name != null ? String(body.name).trim() : existing.name;
  if (name === "") return { ok: false, error: "name cannot be empty" };

  const maxAttendees =
    typeof body.max_attendees === "number"
      ? body.max_attendees
      : existing.max_attendees;
  if (maxAttendees < 1) {
    return { ok: false, error: "max_attendees must be >= 1" };
  }

  // Slug: use provided slug or keep existing
  const rawSlug =
    body.slug != null ? normalizeSlug(String(body.slug)) : existing.slug;
  const slugIndex = await computeSlugIndex(rawSlug);

  const input: EventInput = {
    name,
    slug: rawSlug,
    slugIndex,
    maxAttendees,
    maxPrice:
      typeof body.max_price === "number" ? body.max_price : existing.max_price,
    description:
      body.description != null
        ? String(body.description)
        : existing.description,
    date:
      body.date !== undefined
        ? (optionalString(body.date) ?? "")
        : existing.date,
    location: body.location != null ? String(body.location) : existing.location,
    groupId:
      typeof body.group_id === "number" ? body.group_id : existing.group_id,
    unitPrice:
      typeof body.unit_price === "number"
        ? body.unit_price
        : existing.unit_price,
    maxQuantity:
      typeof body.max_quantity === "number"
        ? body.max_quantity
        : existing.max_quantity,
    thankYouUrl:
      body.thank_you_url != null
        ? String(body.thank_you_url)
        : existing.thank_you_url,
    webhookUrl:
      body.webhook_url != null
        ? String(body.webhook_url)
        : existing.webhook_url,
    active: typeof body.active === "boolean" ? body.active : existing.active,
    fields: body.fields != null ? String(body.fields) : existing.fields,
    closesAt:
      body.closes_at !== undefined
        ? (optionalString(body.closes_at) ?? "")
        : (existing.closes_at ?? ""),
    eventType:
      (body.event_type as EventType | undefined) ?? existing.event_type,
    bookableDays: Array.isArray(body.bookable_days)
      ? body.bookable_days
      : existing.bookable_days,
    minimumDaysBefore:
      typeof body.minimum_days_before === "number"
        ? body.minimum_days_before
        : existing.minimum_days_before,
    maximumDaysAfter:
      typeof body.maximum_days_after === "number"
        ? body.maximum_days_after
        : existing.maximum_days_after,
    nonTransferable:
      typeof body.non_transferable === "boolean"
        ? body.non_transferable
        : existing.non_transferable,
    canPayMore:
      typeof body.can_pay_more === "boolean"
        ? body.can_pay_more
        : existing.can_pay_more,
    hidden: typeof body.hidden === "boolean" ? body.hidden : existing.hidden,
  };

  return { ok: true, input };
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

/** GET /api/admin/events/:eventId — single event detail */
const handleGetEvent = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAdminApi(request, async () => {
    const event = await getEventWithCount(eventId);
    if (!event) return errorResponse("Event not found", 404);
    return jsonResponse({ event: toAdminEvent(event) });
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

/** PUT /api/admin/events/:eventId — update event */
const handleUpdateEvent = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAdminApi(request, async (_session, body) => {
    const existing = await getEventWithCount(eventId);
    if (!existing) return errorResponse("Event not found", 404);

    const parsed = await bodyToUpdateInput(body, existing);
    if (!parsed.ok) return errorResponse(parsed.error);

    // Check slug uniqueness if changed
    if (parsed.input.slug !== existing.slug) {
      const taken = await isSlugTaken(parsed.input.slug, eventId);
      if (taken)
        return errorResponse("Slug is already in use by another event");
    }

    const validationError = await validateEventInput(parsed.input, eventId);
    if (validationError) return errorResponse(validationError);

    // Event existence verified above; update always returns a row
    const row = (await eventsTable.update(eventId, parsed.input))!;
    const updated = await getEventWithCount(row.id);
    await logActivity(`Event '${row.name}' updated`, row);
    return jsonResponse({ event: toAdminEvent(updated!) });
  });

/** DELETE /api/admin/events/:eventId — delete event (requires confirm_name) */
const handleDeleteEvent = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAdminApi(request, async (_session, body) => {
    const event = await getEventWithCount(eventId);
    if (!event) return errorResponse("Event not found", 404);

    const confirmName =
      typeof body.confirm_name === "string" ? body.confirm_name.trim() : "";
    if (confirmName.toLowerCase() !== event.name.trim().toLowerCase()) {
      return errorResponse(
        "Event name does not match. Please provide the exact event name in confirm_name.",
      );
    }

    if (event.image_url) {
      await tryDeleteImage(event.image_url, event.id, "event deletion");
    }
    if (event.attachment_url) {
      await tryDeleteImage(event.attachment_url, event.id, "event deletion");
    }
    await deleteEvent(event.id);
    await logActivity(
      `Event '${event.name}' deleted (${event.attendee_count} attendee(s) removed)`,
    );
    return jsonResponse({ status: "ok" });
  });

/** POST /api/admin/events/:eventId/deactivate — deactivate event */
const handleDeactivateEvent = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAdminApi(request, async () => {
    const event = await getEventWithCount(eventId);
    if (!event) return errorResponse("Event not found", 404);
    if (!event.active) return errorResponse("Event is already deactivated");

    await eventsTable.update(eventId, { active: false });
    await logActivity(`Event '${event.name}' deactivated`, eventId);
    const updated = await getEventWithCount(eventId);
    return jsonResponse({ event: toAdminEvent(updated!) });
  });

/** POST /api/admin/events/:eventId/reactivate — reactivate event */
const handleReactivateEvent = (
  request: Request,
  { eventId }: { eventId: number },
): Promise<Response> =>
  withAdminApi(request, async () => {
    const event = await getEventWithCount(eventId);
    if (!event) return errorResponse("Event not found", 404);
    if (event.active) return errorResponse("Event is already active");

    await eventsTable.update(eventId, { active: true });
    await logActivity(`Event '${event.name}' reactivated`, eventId);
    const updated = await getEventWithCount(eventId);
    return jsonResponse({ event: toAdminEvent(updated!) });
  });

export const adminApiRoutes = defineRoutes({
  "GET /api/admin/events": handleListEvents,
  "GET /api/admin/events/:eventId": handleGetEvent,
  "POST /api/admin/events": handleCreateEvent,
  "PUT /api/admin/events/:eventId": handleUpdateEvent,
  "DELETE /api/admin/events/:eventId": handleDeleteEvent,
  "POST /api/admin/events/:eventId/deactivate": handleDeactivateEvent,
  "POST /api/admin/events/:eventId/reactivate": handleReactivateEvent,
});
