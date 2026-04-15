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
  cell: (e) =>
    `${renderEventImage(e, "event-thumbnail")}<a href="/admin/event/${e.id}">${escapeHtml(e.name)}</a>`,
  description: "Event name with thumbnail image and link to event detail",
  headerText: "Event Name",
  isHtml: true,
  label: "Name",
};

const description: EventCol = {
  cell: (e) => e.description,
  className: "cell-description",
  description: "Event description text",
  label: "Description",
};

const status: EventCol = {
  cell: (e) => (e.active ? "Active" : "Inactive"),
  description: "Whether the event is Active or Inactive",
  label: "Status",
};

const attendees: EventCol = {
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
  description: "Current attendee count vs maximum capacity",
  label: "Attendees",
};

const created: EventCol = {
  cell: (e) => new Date(e.created).toLocaleDateString(),
  description: "Date the event was created",
  label: "Created",
  rawValue: (e) => e.created,
};

const date: EventCol = {
  cell: (e) => (e.date ? new Date(e.date).toLocaleDateString() : ""),
  description: "Scheduled event date",
  label: "Date",
  rawValue: (e) => e.date || "",
};

const location: EventCol = {
  cell: (e) => e.location,
  description: "Event location",
  label: "Location",
};

const price: EventCol = {
  cell: (e) => (e.unit_price > 0 ? String(e.unit_price) : "Free"),
  description: "Ticket unit price (in minor currency units)",
  label: "Price",
  rawValue: (e) => e.unit_price,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available event table columns */
export const EVENT_TABLE_COLUMNS: ColumnGenerators<EventWithCount> = {
  attendees,
  created,
  date,
  description,
  location,
  name,
  price,
  status,
};

/** Default column order for the event table */
export const EVENT_DEFAULT_ORDER = [
  "name",
  "description",
  "status",
  "attendees",
  "created",
] as const;
