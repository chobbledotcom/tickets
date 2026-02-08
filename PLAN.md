# Date Bookings Feature Plan

## Overview

Add "date bookings" — a global system where certain events are marked as "daily", requiring attendees to pick a specific date when booking. Dates are constrained by configurable bookable days of the week, minimum/maximum date range, and a holidays exclusion list.

---

## Phase 1: Admin Settings

### New Site Settings

Add four new keys to `CONFIG_KEYS` in `src/lib/db/settings.ts`:

| Key | Type | Default | Encrypted? |
|-----|------|---------|------------|
| `enable_day_bookings` | `"true"` / `"false"` | `"false"` | No (not sensitive) |
| `bookable_days` | JSON array of day names | `'["Monday","Tuesday","Wednesday","Thursday","Friday"]'` | No |
| `minimum_days_before` | integer string | `"1"` | No |
| `maximum_days_after` | integer string | `"90"` | No |

### Settings Page Changes

**File:** `src/routes/admin/settings.ts` and `src/templates/admin/settings.tsx`

Add a new "Day Bookings" section to the admin settings page (owner-only) with:

- **Enable Day Bookings** — checkbox toggle
- **Bookable Days** — seven checkboxes (Mon–Sun), at least one required when enabled
- **Minimum Days Before** — number input (min: 0), days of notice needed before a bookable date
- **Maximum Days After** — number input (min: 1), how far into the future dates are available

Add a new POST route: `POST /admin/settings/day-bookings` to save these four settings.

### Getter/Helper Functions

In `src/lib/db/settings.ts`, add:

- `getDayBookingsEnabled(): Promise<boolean>`
- `getBookableDays(): Promise<string[]>`
- `getMinDaysBefore(): Promise<number>`
- `getMaxDaysAfter(): Promise<number>`
- `getDayBookingsConfig(): Promise<DayBookingsConfig>` — returns all four in one call (uses the settings cache, so still one DB query)

### Files to Change

- `src/lib/db/settings.ts` — new CONFIG_KEYS, getters, setters
- `src/lib/types.ts` — `DayBookingsConfig` type
- `src/routes/admin/settings.ts` — new POST handler
- `src/templates/admin/settings.tsx` — new form section
- `src/templates/fields.ts` — field definitions for the new form
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

Holidays are global (not per-event). Name is encrypted because it could be culturally sensitive / reveal org details.

### Table Definition

**File:** `src/lib/db/holidays.ts`

Define `holidaysTable` using `defineTable<Holiday, HolidayInput>` with:

- `id` — `col.generated<number>()`
- `name` — `col.encrypted<string>(encrypt, decrypt)`
- `start_date` — `col.simple<string>()`
- `end_date` — `col.simple<string>()`

### Admin CRUD Pages

**New routes in** `src/routes/admin/holidays.ts`:

| Route | Purpose |
|-------|---------|
| `GET /admin/holidays` | List all holidays (decrypted) |
| `GET /admin/holiday/new` | Create form |
| `POST /admin/holiday` | Create holiday |
| `GET /admin/holiday/:id/edit` | Edit form |
| `POST /admin/holiday/:id/edit` | Update holiday |
| `GET /admin/holiday/:id/delete` | Delete confirmation |
| `POST /admin/holiday/:id/delete` | Delete holiday |

### Admin Nav Link

**File:** `src/templates/admin/nav.tsx`

Add a "Holidays" link, conditionally shown when `enable_day_bookings` is `"true"`. This will require the nav component to receive the day-bookings-enabled flag (passed from the route handlers that render admin pages).

### Holiday Validation

- `start_date <= end_date`
- Date format validation (YYYY-MM-DD)
- Name required, non-empty

### Migration

**File:** `src/lib/db/migrations/index.ts`

Add migration step to create the holidays table. Update `LATEST_UPDATE`.

### Files to Create/Change

- `src/lib/db/holidays.ts` — new table definition + queries
- `src/lib/types.ts` — `Holiday`, `HolidayInput` types
- `src/routes/admin/holidays.ts` — new route handlers
- `src/templates/admin/holidays.tsx` — new templates (list, form, delete confirmation)
- `src/templates/fields.ts` — holiday form field definitions
- `src/templates/admin/nav.tsx` — conditional Holidays link
- `src/lib/db/migrations/index.ts` — create holidays table
- `src/routes/router.ts` — register new routes
- Tests for all of the above

---

## Phase 3: Booking Form Changes

### New `event_type` Column on Events

Add an `event_type` column to the events table:

- Type: `TEXT NOT NULL DEFAULT 'standard'`
- Values: `"standard"` (current behavior) or `"daily"` (requires date selection)
- Stored as plaintext (not sensitive — it's a structural flag)

Update the `Event` interface, `EventInput`, `eventsTable` schema, event form fields, and event creation/edit logic.

### Event Form Changes

**File:** `src/templates/fields.ts` and `src/templates/admin/events.tsx`

Add an `event_type` select field to the event creation/editing form:

- Options: `[{ value: "standard", label: "Standard" }, { value: "daily", label: "Daily" }]`
- The "daily" option is only shown/available when `enable_day_bookings` is true
- When day bookings are disabled globally, this field is either hidden or only shows "Standard"

### Available Dates Computation

**New file:** `src/lib/dates.ts`

Core function to compute bookable dates:

```typescript
getAvailableDates(config: DayBookingsConfig, holidays: Holiday[]): string[]
```

Logic:
1. Start from `today + minimum_days_before`
2. End at `today + maximum_days_after`
3. For each day in range, include if:
   - Day of week is in `bookable_days`
   - Day does not fall within any holiday's `start_date..end_date` range
4. Return as sorted array of ISO date strings (`"YYYY-MM-DD"`)

### Public Booking Form Changes

**File:** `src/templates/public.tsx` and `src/routes/public.ts`

For events where `event_type === "daily"`:

- Render a `<select>` dropdown with available dates (formatted nicely, e.g., "Monday 15 March 2026")
- The date field is required — form submission fails without a date
- For multi-ticket bookings: one shared date selector applies to all daily events in the batch
- For mixed batches (standard + daily events): date selector shown, applies only to daily events

### Attendee Creation Changes

**File:** `src/lib/db/attendees.ts`

- Add `date` column to attendees table: `TEXT DEFAULT NULL`, plaintext (as specified — not encrypted)
- Update `createAttendeeAtomic()` to accept optional `date` parameter
- Update `Attendee` interface to include `date: string | null`
- For daily events, `date` is required at the route handler level; for standard events it stays null

### Migration

Add `date` column to attendees table and `event_type` column to events table. Update `LATEST_UPDATE`.

### Validation

- If event is daily, date must be present and must be in the available dates list (server-side re-validation)
- Prevents booking on holidays, non-bookable days, or outside the allowed date range

### Files to Create/Change

- `src/lib/dates.ts` — new date computation logic
- `src/lib/types.ts` — update `Event`, `Attendee`, add `EventType`
- `src/lib/db/events.ts` — update `eventsTable` schema
- `src/lib/db/attendees.ts` — add `date` column, update `createAttendeeAtomic`
- `src/templates/fields.ts` — add `event_type` field to event form fields
- `src/templates/admin/events.tsx` — show event_type in event form
- `src/templates/public.tsx` — date selector for daily events
- `src/routes/public.ts` — validate date, pass to attendee creation
- `src/lib/db/migrations/index.ts` — add columns
- Tests for all of the above

---

## Phase 4: Admin Event View Changes & CSV

### Date Filter on Admin Event Page

**File:** `src/routes/admin/events.ts` and `src/templates/admin/events.tsx`

For daily events, add a date filter to the attendee list view:

- Show a `<select>` dropdown above the attendee table with:
  - "All dates" option (default — shows all attendees regardless of date)
  - Each unique date that has at least one attendee, formatted as "Monday 15 March 2026"
- Selecting a date reloads the page with a `?date=YYYY-MM-DD` query parameter
- The attendee table is filtered to only show attendees for the selected date
- The existing checked-in/out filter still works alongside the date filter
- For standard events, no date selector is shown (everything works as before)

### Attendee Table Changes

- Add a "Date" column to the attendee table for daily events
- Shows the formatted booking date for each attendee

### CSV Export Changes

**File:** `src/templates/csv.ts` and `src/routes/admin/events.ts`

- Add "Date" column to CSV output (after Ticket Token, or as first column for daily events)
- The export route (`GET /admin/event/:id/export`) respects the `?date=` query parameter:
  - With `?date=YYYY-MM-DD` → only exports attendees for that date
  - Without date parameter → exports all attendees (with date column populated)
- For standard events, the Date column is omitted from the CSV entirely

### Admin Event Detail Display

- Show the event type (Standard / Daily) in the event details table
- For daily events, show a summary of bookings per date

### Files to Change

- `src/routes/admin/events.ts` — date query param parsing, filtered fetching, pass to template
- `src/templates/admin/events.tsx` — date selector dropdown, date column in table, event type display
- `src/templates/csv.ts` — conditional date column
- Tests for all of the above

---

## Questions

Before starting implementation, a few things to confirm:

1. **Event type naming**: I've proposed `event_type` with values `"standard"` and `"daily"`. Is that naming right, or would you prefer something else (e.g., `"regular"`/`"daily"`, or a boolean `is_daily`)?

2. **Settings encryption**: I've proposed storing the four day-booking settings as plaintext (not AES-encrypted) since they're not sensitive. The holiday *name* would be encrypted. Does that sound right?

3. **Holiday ownership**: Holidays are global (shared across all daily events, not per-event). Correct?

4. **Admin nav visibility**: The Holidays link should only appear for owners (like Settings, Users, etc.), or for all admin levels?

5. **Date selector UX**: I've proposed a `<select>` dropdown with pre-computed available dates (formatted as "Monday 15 March 2026"). HTML's native `<input type="date">` can't enforce day-of-week or holiday restrictions without JavaScript, so a pre-filtered `<select>` seems like the right approach for this no-JS-required system. Agreed?

6. **Multi-event bookings with mixed types**: If someone books a standard event and a daily event together via `/ticket/slug1+slug2`, should the date selector appear for just the daily event(s)? Or should we disallow mixing standard and daily events in multi-bookings?

7. **Max attendees for daily events**: Does `max_attendees` apply per-date (e.g., 50 people per day) or total across all dates? Per-date seems more useful for daily bookings.
