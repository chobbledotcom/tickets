# Date Bookings Feature Plan

## Overview

Add "date bookings" — events can be marked as "daily", requiring attendees to pick a specific date when booking. Each daily event configures its own bookable days of the week, minimum notice period, and maximum future range. A global holidays table excludes date ranges from all daily events. For daily events, `max_attendees` applies **per date**.

---

## Phase 1: Event Type & Per-Event Date Configuration

### New Columns on Events Table

Add four new columns to the `events` table:

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `event_type` | `TEXT NOT NULL` | `'standard'` | `"standard"` or `"daily"` |
| `bookable_days` | `TEXT NOT NULL` | `'["Monday","Tuesday","Wednesday","Thursday","Friday"]'` | JSON array of day names, plaintext |
| `minimum_days_before` | `INTEGER NOT NULL` | `1` | Days of notice needed |
| `maximum_days_after` | `INTEGER NOT NULL` | `90` | How far into the future |

All four are plaintext (structural config, like `max_attendees` and `fields`).

### Type Changes

**File:** `src/lib/types.ts`

```typescript
type EventType = "standard" | "daily";
```

Add to `Event` interface: `event_type`, `bookable_days`, `minimum_days_before`, `maximum_days_after`.

Add to `EventInput`: corresponding camelCase fields.

### Table Schema Changes

**File:** `src/lib/db/events.ts`

Add to `eventsTable` schema:
- `event_type` — `col.withDefault<EventType>(() => "standard")`
- `bookable_days` — `col.withDefault(() => '["Monday","Tuesday","Wednesday","Thursday","Friday"]')`
- `minimum_days_before` — `col.withDefault(() => 1)`
- `maximum_days_after` — `col.withDefault(() => 90)`

### Event Form Changes

**File:** `src/templates/fields.ts` and `src/templates/admin/events.tsx`

Add to the event creation/editing form:

- **Event Type** — select: `Standard` / `Daily`
- **Bookable Days** — seven checkboxes (Mon–Sun), only shown when type is `daily`. At least one required. Since the form system uses `Field[]` which doesn't support conditional visibility or checkbox groups natively, this will need custom rendering in the template (not driven by the field definitions). Validation will be handled in the route handler.
- **Minimum Days Before** — number input (min: 0), only shown when type is `daily`
- **Maximum Days After** — number input (min: 1), only shown when type is `daily`

The daily-specific fields can be rendered always but visually grouped — server-side validation will enforce them when `event_type` is `"daily"`. No JavaScript needed: if someone submits a daily event without bookable days checked, the server rejects it.

### Event Input Extraction

**File:** `src/routes/admin/events.ts`

Update `extractEventInput` and `extractEventUpdateInput` to handle:
- `event_type` from form
- `bookable_days` — collect checked day checkboxes, serialize to JSON array string
- `minimum_days_before` and `maximum_days_after` as integers

### Migration

**File:** `src/lib/db/migrations/index.ts`

```sql
ALTER TABLE events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE events ADD COLUMN bookable_days TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]';
ALTER TABLE events ADD COLUMN minimum_days_before INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN maximum_days_after INTEGER NOT NULL DEFAULT 90;
```

Update `LATEST_UPDATE`.

### Files to Change

- `src/lib/types.ts` — `EventType`, update `Event` and `EventInput`
- `src/lib/db/events.ts` — update `eventsTable` schema
- `src/lib/db/migrations/index.ts` — add columns
- `src/templates/fields.ts` — `event_type` select field
- `src/templates/admin/events.tsx` — daily config fields in event form, show event type in detail view
- `src/routes/admin/events.ts` — extract and validate daily fields
- Tests for all of the above

---

## Phase 2: Holidays Management

### New `holidays` Table

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,        -- AES-256-GCM encrypted (symmetric, using DB_ENCRYPTION_KEY)
  start_date TEXT NOT NULL,  -- ISO date "YYYY-MM-DD", plaintext
  end_date TEXT NOT NULL     -- ISO date "YYYY-MM-DD", plaintext
);
```

Holidays are global (not per-event). Name is encrypted because it could reveal organisational details.

### Table Definition

**File:** `src/lib/db/holidays.ts`

Define `holidaysTable` using `defineTable<Holiday, HolidayInput>` with:

- `id` — `col.generated<number>()`
- `name` — `col.encrypted<string>(encrypt, decrypt)`
- `start_date` — `col.simple<string>()`
- `end_date` — `col.simple<string>()`

Additional query helpers:
- `getAllHolidays()` — returns all holidays, decrypted, ordered by `start_date`
- `getActiveHolidays()` — returns holidays where `end_date >= today` (for date computation)

### Admin CRUD Pages

**New routes in** `src/routes/admin/holidays.ts`:

| Route | Purpose |
|-------|---------|
| `GET /admin/holidays` | List all holidays (decrypted, sorted by start_date) |
| `GET /admin/holiday/new` | Create form |
| `POST /admin/holiday` | Create holiday |
| `GET /admin/holiday/:id/edit` | Edit form |
| `POST /admin/holiday/:id/edit` | Update holiday |
| `GET /admin/holiday/:id/delete` | Delete confirmation |
| `POST /admin/holiday/:id/delete` | Delete holiday (with name verification, matching existing patterns) |

### Admin Nav Link

**File:** `src/templates/admin/nav.tsx`

Add a "Holidays" link, visible to owners (alongside Settings, Users, etc.).

### Holiday Form Fields

**File:** `src/templates/fields.ts`

```typescript
const holidayFields: Field[] = [
  { name: "name", label: "Name", type: "text", required: true, placeholder: "Bank Holiday" },
  { name: "start_date", label: "Start Date", type: "date", required: true },
  { name: "end_date", label: "End Date", type: "date", required: true },
];
```

Custom validation: `start_date <= end_date`, valid date format.

### Templates

**File:** `src/templates/admin/holidays.tsx`

- **List page**: Table with Name, Start Date, End Date, Edit/Delete links. "Add Holiday" button.
- **Create/Edit form**: Name, Start Date, End Date fields with error display.
- **Delete confirmation**: Shows holiday name, requires name confirmation (matching event delete pattern).

### Migration

**File:** `src/lib/db/migrations/index.ts`

Add `CREATE TABLE IF NOT EXISTS holidays` step. Update `LATEST_UPDATE`.

### Files to Create/Change

- `src/lib/db/holidays.ts` — new table definition + queries
- `src/lib/types.ts` — `Holiday`, `HolidayInput` types
- `src/routes/admin/holidays.ts` — new route handlers
- `src/templates/admin/holidays.tsx` — new templates
- `src/templates/fields.ts` — holiday form field definitions
- `src/templates/admin/nav.tsx` — Holidays link (owner-only)
- `src/lib/db/migrations/index.ts` — create holidays table
- `src/routes/router.ts` — register new routes
- Tests for all of the above

---

## Phase 3: Booking Form Changes

### Available Dates Computation

**New file:** `src/lib/dates.ts`

Core function to compute bookable dates for a daily event:

```typescript
getAvailableDates(event: Event, holidays: Holiday[]): string[]
```

Logic:
1. Start from `today + event.minimum_days_before`
2. End at `today + event.maximum_days_after`
3. For each day in range, include if:
   - Day of week name is in `event.bookable_days` (parsed from JSON)
   - Day does not fall within any holiday's `start_date..end_date` range (inclusive)
4. Return as sorted array of ISO date strings (`"YYYY-MM-DD"`)

Helper to format dates for display:

```typescript
formatDateLabel(dateStr: string): string  // "Monday 15 March 2026"
```

### New `date` Column on Attendees

Add to `attendees` table:

```sql
ALTER TABLE attendees ADD COLUMN date TEXT DEFAULT NULL;
```

- Plaintext (as specified — not encrypted)
- `NULL` for standard events, `"YYYY-MM-DD"` for daily events

### Per-Date Capacity Check

**File:** `src/lib/db/attendees.ts`

For daily events, `max_attendees` applies **per date**. Update `createAttendeeAtomic()`:

- Accept optional `date` parameter
- When `date` is provided, the atomic capacity check counts only attendees with the same `date` value (not all attendees for the event)
- The SQL changes from `WHERE event_id = ?` to `WHERE event_id = ? AND date = ?`

Also update `hasAvailableSpots()` similarly for paid event pre-checks.

### Public Booking Form Changes

**File:** `src/templates/public.tsx`

For events where `event_type === "daily"`:

- Render a `<select name="date">` dropdown with available dates
- Each option: `<option value="2026-03-15">Monday 15 March 2026</option>`
- First option: `<option value="">— Select a date —</option>` (no default selection)
- The date field is required — form validation rejects empty selection

For multi-ticket bookings (`/ticket/slug1+slug2`):
- If any event is daily, show one shared date selector
- The date applies to all daily events in the batch
- Standard events in the batch ignore the date

### Public Route Changes

**File:** `src/routes/public.ts`

- Extract `date` from form data for daily events
- Server-side validation: re-compute available dates and verify the submitted date is in the list (prevents tampering)
- Pass `date` to `createAttendeeAtomic()` for daily events, `null` for standard events
- For paid events: include `date` in the `RegistrationIntent` so it survives the payment flow

### Migration

**File:** `src/lib/db/migrations/index.ts`

```sql
ALTER TABLE attendees ADD COLUMN date TEXT DEFAULT NULL;
```

Note: The `event_type` and related event columns are added in Phase 1's migration. This phase only adds the attendee `date` column. Both can share the same `LATEST_UPDATE` bump if implemented together, but logically they're separate concerns.

### Files to Create/Change

- `src/lib/dates.ts` — new date computation + formatting logic
- `src/lib/types.ts` — update `Attendee` interface
- `src/lib/db/attendees.ts` — add `date` column, update `createAttendeeAtomic` and `hasAvailableSpots`
- `src/templates/public.tsx` — date selector for daily events
- `src/routes/public.ts` — validate date, pass to attendee creation, update payment flow
- `src/lib/db/migrations/index.ts` — add `date` column to attendees
- Tests for all of the above

---

## Phase 4: Admin Event View Changes & CSV

### Date Filter on Admin Event Page

**File:** `src/routes/admin/events.ts` and `src/templates/admin/events.tsx`

For daily events, add a date filter to the attendee list view:

- Show a `<select>` dropdown (as a form with auto-submit or as links) above the attendee table:
  - **"All dates"** option (default — shows all attendees)
  - Each unique date that has at least one attendee, formatted nicely
- Selecting a date reloads the page with a `?date=YYYY-MM-DD` query parameter
- The attendee table is filtered to only show attendees for the selected date
- The existing checked-in/out URL filter (`/in`, `/out`) works alongside the date filter (combined filtering)
- For standard events, no date selector is shown (everything works as before)

### Attendee Count Per Date

For daily events, the event detail section should show capacity info per-date context:
- When filtered to a specific date: show "X / max_attendees" for that date
- When showing all: show total attendee count across all dates

### Attendee Table Changes

- Add a "Date" column to the attendee table for daily events (showing formatted date)
- Column hidden for standard events

### CSV Export Changes

**File:** `src/templates/csv.ts` and `src/routes/admin/events.ts`

- Add "Date" column to CSV output for daily events (omitted for standard events)
- The export route (`GET /admin/event/:id/export`) respects the `?date=` query parameter:
  - With `?date=YYYY-MM-DD` → only exports attendees for that date
  - Without date parameter → exports all attendees with the date column included
- CSV filename includes the date when filtered: `{event_name}_{date}_attendees.csv`

### Admin Event Detail Display

- Show "Event Type: Daily" or "Event Type: Standard" in the event details table
- For daily events, also show: Bookable Days, Min Days Before, Max Days After

### Files to Change

- `src/routes/admin/events.ts` — date query param parsing, filtered attendees, pass to template and CSV
- `src/templates/admin/events.tsx` — date selector dropdown, date column in table, event type in details
- `src/templates/csv.ts` — conditional date column, date filtering
- Tests for all of the above

---

## Phase 4 Outstanding Work

Phase 4 is largely unimplemented. The event detail metadata display is done (event type, bookable days, booking window), but all attendee filtering and CSV features are missing.

### Done

- Event type, bookable days, and booking window shown in event detail view

### Not Done

- `?date=YYYY-MM-DD` query parameter parsing in admin event route
- Date selector dropdown above attendee table for daily events
- Attendee filtering by date (server-side, composable with check-in filter)
- "Date" column in attendee table for daily events
- Per-date capacity count (currently shows total count with misleading "(per date)" label)
- "Date" column in CSV export for daily events
- CSV export respecting `?date=` filter parameter
- Date in CSV filename when filtered (`{event_name}_{date}_attendees.csv`)

---

## Phase 5: Post-MVP Improvements

Features beyond the original plan that would be needed for real-world daily booking use:

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

### Admin Calendar View

Daily events are calendar-shaped data shown in a flat table. A month or week view showing bookings-per-date would be far more practical for capacity management than scrolling through a list.
