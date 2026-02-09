# Date Bookings Feature Plan

## Overview

Add "date bookings" — events can be marked as "daily", requiring attendees to pick a specific date when booking. Each daily event configures its own bookable days of the week, minimum notice period, and maximum future range. A global holidays table excludes date ranges from all daily events. For daily events, `max_attendees` applies **per date**.

---

## Completed

### Phase 1: Event Type & Per-Event Date Configuration

Added four new columns to the `events` table:

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `event_type` | `TEXT NOT NULL` | `'standard'` | `"standard"` or `"daily"` |
| `bookable_days` | `TEXT NOT NULL` | `'["Monday","Tuesday","Wednesday","Thursday","Friday"]'` | JSON array of day names, plaintext |
| `minimum_days_before` | `INTEGER NOT NULL` | `1` | Days of notice needed |
| `maximum_days_after` | `INTEGER NOT NULL` | `90` | How far into the future |

All four are plaintext (structural config, like `max_attendees` and `fields`).

**What was done:**

- `EventType` union (`"standard" | "daily"`) and new fields on `Event`/`EventInput` interfaces (`src/lib/types.ts`)
- `eventsTable` schema updated with default columns (`src/lib/db/events.ts`)
- Migration adding four columns to `events` table (`src/lib/db/migrations/index.ts`)
- Event creation/editing form: event type select, bookable days checkboxes, minimum/maximum days inputs (`src/templates/fields.ts`, `src/templates/admin/events.tsx`)
- `extractEventInput`/`extractEventUpdateInput` updated to handle daily fields (`src/routes/admin/events.ts`)
- Server-side validation for daily events (at least one bookable day required)

### Phase 2: Holidays Management

Global holidays table that excludes date ranges from all daily events.

**What was done:**

- `holidays` table with encrypted name, plaintext start/end dates (`src/lib/db/holidays.ts`)
- `Holiday`/`HolidayInput` types (`src/lib/types.ts`)
- Full admin CRUD: list, create, edit, delete with name verification (`src/routes/admin/holidays.ts`)
- Holiday templates: list page, create/edit form, delete confirmation (`src/templates/admin/holidays.tsx`)
- Holiday form field definitions (`src/templates/fields.ts`)
- "Holidays" link in admin nav, owner-only (`src/templates/admin/nav.tsx`)
- Migration creating `holidays` table (`src/lib/db/migrations/index.ts`)
- Routes registered in router (`src/routes/router.ts`)

### Phase 3: Booking Form Changes

Public booking form supports date selection for daily events, with per-date capacity enforcement.

**What was done:**

- Available dates computation: `getAvailableDates()` and `formatDateLabel()` (`src/lib/dates.ts`)
- `date` column added to `attendees` table — `NULL` for standard events, `"YYYY-MM-DD"` for daily (`src/lib/db/attendees.ts`)
- Per-date capacity check in `createAttendeeAtomic()` and `hasAvailableSpots()` — counts only attendees with matching date
- Date selector dropdown on public booking form for daily events (`src/templates/public.tsx`)
- Server-side date validation: re-computes available dates and verifies submitted date is valid (`src/routes/public.ts`)
- `date` included in `RegistrationIntent` for paid event payment flow
- Multi-ticket bookings: shared date selector when any event is daily

### Phase 4: Admin Event View Changes & CSV

Admin event detail page shows daily event configuration and supports date-filtered attendee views.

**What was done:**

- Event type, bookable days, and booking window shown in event detail view
- `?date=YYYY-MM-DD` query parameter parsing in admin event route
- Date selector dropdown above attendee table for daily events
- Attendee filtering by date (server-side, composable with check-in filter)
- "Date" column in attendee table for daily events
- Per-date capacity count when filtered (total count with capacity note when unfiltered)
- "Date" column in CSV export for daily events
- CSV export respecting `?date=` filter parameter
- Date in CSV filename when filtered (`{event_name}_{date}_attendees.csv`)
- Export CSV link preserves active date filter

### Admin Calendar View

Daily events have a dedicated calendar-style admin view for browsing bookings by date.

**What was done:**

- Calendar route and template (`src/routes/admin/calendar.ts`, `src/templates/admin/calendar.tsx`)
- Date selector filtering by dates with bookings
- Attendee table by selected date with CSV export

---

## Outstanding

### Ticket & Check-in Date Display

The booked date is not shown on the ticket view (`src/templates/tickets.tsx`) or the check-in page (`src/templates/checkin.tsx`). For daily events, the date is the most important piece of information — attendees need to see it on their ticket, and operators checking people in need to verify the correct date.

### Webhook Date Field

The outgoing webhook payload (`src/lib/webhook.ts`) does not include the attendee's booked date. External integrations receiving webhook notifications for daily events have no way to know which date was booked.

### Per-Date Availability on Public Form

The public date dropdown shows all available dates but gives no indication of remaining capacity per date. Users may select a date only to get a "full" error after submitting. Showing remaining spots (e.g. "Monday 15 March (3 spots left)") would prevent this.

### Per-Event Date Overrides

Currently the only way to block a specific date is to create a global holiday, which affects all daily events. A per-event date blacklist would let operators cancel individual dates (emergency, staffing) without affecting other events.

### Bulk Holiday Import

Holidays must be entered one at a time. A bulk import (paste a list, or import a country's public holidays) would save significant setup time for real deployments.
