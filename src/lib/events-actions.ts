/**
 * Shared event business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

import { formatCurrency } from "#lib/currency.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { groupsTable, validateGroupEventType } from "#lib/db/groups.ts";
import { generateUniqueSlug } from "#lib/slug.ts";
import { deleteEventStorageFiles } from "#lib/storage.ts";
import type { Event, EventWithCount } from "#lib/types.ts";

/** Generate a unique event slug, retrying on collision */
export const generateUniqueEventSlug = (excludeEventId?: number) =>
  generateUniqueSlug(computeSlugIndex, (slug) =>
    isSlugTaken(slug, excludeEventId),
  );

/** Validate max_price is at least unit_price + 100 cents */
const validateMaxPrice = (input: EventInput): string | null => {
  const minPrice = (input.unitPrice ?? 0) + 100;
  return input.maxPrice < minPrice
    ? `Maximum price must be at least ${formatCurrency(
        100,
      )} more than the ticket price`
    : null;
};

/** Validate event input (slug uniqueness on update, group, max price, event type) */
export const validateEventInput = async (
  input: EventInput,
  existingId?: number,
): Promise<string | null> => {
  if (existingId !== undefined) {
    const taken = await isSlugTaken(input.slug, existingId);
    if (taken) return "Slug is already in use by another event";
  }
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

/**
 * Delete an event: clean up images/attachments, remove from DB, log activity.
 * Returns the event that was deleted (for response formatting).
 */
export const performEventDelete = async (
  event: EventWithCount,
): Promise<void> => {
  await deleteEventStorageFiles(event, "event deletion");
  await deleteEvent(event.id);
  await logActivity(
    `Event '${event.name}' deleted (${event.attendee_count} attendee(s) removed)`,
  );
};

/**
 * Build an `EventInput` from an existing event, with optional overrides.
 *
 * Produces a fresh unique slug (so the returned input is safe to insert).
 * Image and attachment URLs are cleared by default: they reference files
 * owned by the source event and would break if the original were deleted.
 * Callers can override any field (e.g. `name`, `date`, `groupId`) via
 * `overrides`.
 *
 * Used by both the per-event duplicate form and the group-bulk duplicate
 * flow so the set of carried-over fields stays in one place.
 */
export const buildDuplicateEventInput = async (
  source: Event,
  overrides: Partial<EventInput> = {},
): Promise<EventInput> => {
  const { slug, slugIndex } = await generateUniqueEventSlug();
  const base: EventInput = {
    active: source.active,
    assignBuiltSite: source.assign_built_site,
    attachmentName: "",
    attachmentUrl: "",
    bookableDays: [...source.bookable_days],
    canPayMore: source.can_pay_more,
    closesAt: source.closes_at ?? "",
    date: source.date,
    description: source.description,
    eventType: source.event_type,
    fields: source.fields,
    groupId: source.group_id,
    hidden: source.hidden,
    imageUrl: "",
    location: source.location,
    maxAttendees: source.max_attendees,
    maximumDaysAfter: source.maximum_days_after,
    maxPrice: source.max_price,
    maxQuantity: source.max_quantity,
    minimumDaysBefore: source.minimum_days_before,
    name: source.name,
    nonTransferable: source.non_transferable,
    purchaseOnly: source.purchase_only,
    slug,
    slugIndex,
    thankYouUrl: source.thank_you_url,
    unitPrice: source.unit_price,
    webhookUrl: source.webhook_url,
  };
  return { ...base, ...overrides };
};

/**
 * Toggle event active state, log activity, and return the updated event.
 * Returns null if the event is already in the target state.
 */
export const toggleEventActive = async (
  eventId: number,
  event: EventWithCount,
  active: boolean,
): Promise<EventWithCount | null> => {
  if (event.active === active) return null;
  await eventsTable.update(eventId, { active });
  const verb = active ? "reactivated" : "deactivated";
  await logActivity(`Event '${event.name}' ${verb}`, eventId);
  return (await getEventWithCount(eventId))!;
};
