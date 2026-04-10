/**
 * Event table column definitions.
 *
 * Maps column keys to their rendering logic for the admin dashboard event table.
 * This is the single source of truth for available event columns, their headers,
 * cell rendering, and guide documentation.
 */

import type { ColumnDef, ColumnGenerators } from "#lib/column-order.ts";
import type { EventWithCount } from "#lib/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

type EventCol = ColumnDef<EventWithCount>;

const name: EventCol = {
  label: "Name",
  headerText: "Event Name",
  description: "Event name with thumbnail image and link to event detail",
  cell: (e) =>
    `${renderEventImage(e, "event-thumbnail")}<a href="/admin/event/${e.id}">${escapeHtml(e.name)}</a>`,
  isHtml: true,
};

const description: EventCol = {
  label: "Description",
  description: "Event description text",
  cell: (e) => e.description,
  className: "cell-description",
};

const status: EventCol = {
  label: "Status",
  description: "Whether the event is Active or Inactive",
  cell: (e) => (e.active ? "Active" : "Inactive"),
};

const attendees: EventCol = {
  label: "Attendees",
  description: "Current attendee count vs maximum capacity",
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
};

const created: EventCol = {
  label: "Created",
  description: "Date the event was created",
  cell: (e) => new Date(e.created).toLocaleDateString(),
  rawValue: (e) => e.created,
};

const date: EventCol = {
  label: "Date",
  description: "Scheduled event date",
  cell: (e) => (e.date ? new Date(e.date).toLocaleDateString() : ""),
  rawValue: (e) => e.date || "",
};

const location: EventCol = {
  label: "Location",
  description: "Event location",
  cell: (e) => e.location,
};

const price: EventCol = {
  label: "Price",
  description: "Ticket unit price (in minor currency units)",
  cell: (e) => (e.unit_price > 0 ? String(e.unit_price) : "Free"),
  rawValue: (e) => e.unit_price,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available event table columns */
export const EVENT_TABLE_COLUMNS: ColumnGenerators<EventWithCount> = {
  name,
  description,
  status,
  attendees,
  created,
  date,
  location,
  price,
};

/** Default column order for the event table */
export const EVENT_DEFAULT_ORDER = [
  "name",
  "description",
  "status",
  "attendees",
  "created",
] as const;
