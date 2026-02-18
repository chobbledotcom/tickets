# Plan: Unify Attendee Table Rendering

## Context

Three separate attendee table implementations exist across the codebase, each showing different columns in different orders. The goal is to replace all three with a single shared `AttendeeTable` component that:
- Shows all possible columns in a consistent order everywhere
- Dynamically hides columns when no data exists (email, phone, address, special instructions)
- Hides the Event column when viewing a single event
- Always shows the Checked-in column first (as a check-in/out button in all views)
- Always shows the Actions column (Edit, Delete, Re-send Webhook, and conditionally Refund)
- Supports a `returnUrl` so actions redirect back to the originating page

## Current State

| View | File | Columns |
|------|------|---------|
| Event detail | `src/templates/admin/events.tsx:75-110` | Check-in button, [Date], Name, Email, Phone, Address, Special Instructions, Qty, Ticket, Registered, Actions |
| Check-in | `src/templates/checkin.tsx:17-29` | Event, [Date], Name, Email, Phone, Qty, Checked In (Yes/No text) |
| Calendar | `src/templates/admin/calendar.tsx:43-54` | Event, Name, Email, Phone, Qty, Ticket, Registered |

## Unified Column Order

| # | Column | Visibility |
|---|--------|-----------|
| 1 | Checked In | Always (check-in/out button form) |
| 2 | Event | Hidden when `showEvent: false` (single-event view) |
| 3 | Date | Hidden when `showDate: false` |
| 4 | Name | Always |
| 5 | Email | Hidden if no attendee has email |
| 6 | Phone | Hidden if no attendee has phone |
| 7 | Address | Hidden if no attendee has address |
| 8 | Special Instructions | Hidden if no attendee has special instructions |
| 9 | Qty | Always |
| 10 | Ticket | Always |
| 11 | Registered | Always |
| 12 | Actions | Always (Refund conditional on `hasPaidEvent && payment_id`) |

## Data Model

```typescript
// src/templates/attendee-table.tsx

export type AttendeeTableRow = {
  attendee: Attendee;
  eventId: number;
  eventName?: string;     // required when showEvent is true
  hasPaidEvent: boolean;  // controls Refund link visibility
};

export type AttendeeTableOptions = {
  rows: AttendeeTableRow[];
  allowedDomain: string;
  csrfToken: string;
  showEvent: boolean;
  showDate: boolean;
  activeFilter?: string;  // defaults to "all", for check-in form return_filter
  returnUrl?: string;     // URL to redirect back to after actions
  emptyMessage?: string;
};
```

## Implementation Steps

### Step 1: Create `src/templates/attendee-table.tsx`

New shared component containing:
- Type exports (`AttendeeTableRow`, `AttendeeTableOptions`)
- `formatAddressInline` (moved from `events.tsx` — avoids circular imports)
- `computeVisibility(rows, opts)` — derives which optional columns to show by checking `rows.some(r => !!r.attendee.email)` etc.
- Check-in button rendering (moved from `events.tsx` `CheckinButton`)
- Actions cell rendering: Edit link (`/admin/attendees/{id}`), Delete link, Re-send Webhook link, conditional Refund link — all with `?return_url=<encoded>` when `returnUrl` is provided
- `AttendeeTable(opts)` — renders `<table>` with `<thead>` and `<tbody>`

Uses: `pipe`, `map`, `reduce`, `compact` from `#fp`; `formatDateLabel` from `#lib/dates.ts`; `Raw` from `#lib/jsx/jsx-runtime.ts`

### Step 2: Refactor `src/templates/admin/events.tsx`

- Remove `CheckinButton` (lines 56-73), `AttendeeRow` (lines 75-110), `joinStrings` (line 29)
- Re-export `formatAddressInline` from `#templates/attendee-table.tsx` (preserves existing test imports in `html.test.ts`)
- Import and use `AttendeeTable` with `AttendeeTableRow`
- In `adminEventPage`, replace table HTML (lines 374-394) with `AttendeeTable` call:
  - `showEvent: false`, `showDate: isDaily`
  - `returnUrl`: current page path incorporating the active filter, e.g. `/admin/event/{id}/in`
  - Map `filteredAttendees` to `AttendeeTableRow[]` with `eventId: event.id`, `hasPaidEvent: event.unit_price !== null`

### Step 3: Refactor `src/templates/checkin.tsx`

- Remove `renderCheckinRow` (lines 17-29)
- Update `checkinAdminPage` signature to add `allowedDomain: string` parameter
- Import and use `AttendeeTable` with `AttendeeTableRow`
- Map `TokenEntry[]` to `AttendeeTableRow[]` using `entry.event.id`, `entry.event.name`, `entry.event.unit_price !== null`
- Replace table HTML (lines 62-77) with `AttendeeTable` call:
  - `showEvent: true`, `showDate` derived from entries as before
  - `returnUrl`: the check-in page path (`/checkin/{tokens}`)

### Step 4: Update `src/routes/checkin.ts`

- Import `getAllowedDomain` from `#lib/config.ts`
- Pass `getAllowedDomain()` to `checkinAdminPage`

### Step 5: Refactor `src/templates/admin/calendar.tsx`

- Remove local `AttendeeRow` (lines 43-54), `joinStrings` (line 12)
- Add `hasPaidEvent: boolean` to `CalendarAttendeeRow` type
- Import and use `AttendeeTable` with `AttendeeTableRow`
- Map `CalendarAttendeeRow[]` to `AttendeeTableRow[]`
- Replace table HTML (lines 92-107) with `AttendeeTable` call:
  - `showEvent: true`, `showDate: false`
  - `csrfToken` from session (already available — `adminCalendarPage` receives `session: AdminSession`)
  - `returnUrl`: `/admin/calendar?date={dateFilter}#attendees`

### Step 6: Update `src/routes/admin/calendar.ts`

- In `buildCalendarAttendees`, add `hasPaidEvent: event.unit_price !== null` to each row

### Step 7: Add `return_url` support to action routes and templates

The `AttendeeTable` will append `?return_url=<encoded>` to action links and include `<input type="hidden" name="return_url" value="...">` in check-in forms.

**Shared redirect helper** (`src/routes/admin/attendees.ts` or `src/routes/utils.ts`):

```typescript
/** Redirect to return_url from form if present, otherwise redirect to fallback */
const redirectOrReturn = (form: URLSearchParams, fallback: string): Response => {
  const returnUrl = form.get("return_url");
  return redirect(returnUrl || fallback);
};
```

All POST handlers below replace their `return redirect(...)` calls with `redirectOrReturn(form, <current-fallback>)`. This avoids repeating the return_url-reading logic in every handler.

**Route handlers that use the helper** (`src/routes/admin/attendees.ts`):

- `handleAttendeeCheckin` (line 158): Replace `return_filter` / `filterSuffix` logic with `redirectOrReturn(form, <event-page>)`.
- `handleAttendeeDelete` (line 147): `redirectOrReturn(form, `/admin/event/${eventId}`)`.
- `handleAttendeeRefund` (line 186): Same pattern.
- `handleResendWebhook` (line 456): Same pattern.
- `handleEditAttendeePost` (line 400): Same pattern.

**Confirmation page templates** (`src/templates/admin/attendees.tsx`):

- `adminDeleteAttendeePage` (line 15): Add optional `returnUrl` param. Include `<input type="hidden" name="return_url" value="...">` in the form when provided.
- `adminRefundAttendeePage` (line 63): Same.
- `adminResendWebhookPage` (line 254): Same.
- `adminEditAttendeePage` (line 177): Same.

**GET route handlers** (`src/routes/admin/attendees.ts`):

- `handleAdminAttendeeDeleteGet` (line 143): Read `return_url` from query params (`getSearchParam`), pass to template.
- `handleAdminAttendeeRefundGet` (line 180): Same.
- `handleAdminResendWebhookGet` (line 452): Same.
- `handleEditAttendeeGet` (line 383): Same.

**Fallback behavior**: When `return_url` is not present (e.g. direct navigation to the action page), `redirectOrReturn` falls back to the current behavior of redirecting to `/admin/event/{eventId}`.

### Step 8: Create `test/lib/attendee-table.test.ts`

Tests for the unified component:
- Always-visible columns: Checked In (button), Name, Qty, Ticket, Registered, Actions are always rendered
- Event column hidden/shown based on `showEvent`
- Date column hidden/shown based on `showDate`
- Email/Phone/Address/Special Instructions hidden when no data, shown when any row has data
- Check-in button renders correct form action and toggle label (Check in / Check out)
- Actions: Edit, Delete, Re-send Webhook always shown; Refund only when `hasPaidEvent && payment_id`
- `return_url` appended to action links and included in check-in form as hidden field
- Empty state with correct colspan
- Column order matches specification
- Ticket token renders as link with correct domain
- `formatAddressInline` (moved function, existing tests should still pass via re-export)

### Step 9: Update existing tests

- `test/lib/html.test.ts`: Import of `formatAddressInline` stays via re-export from `events.tsx`. Adjust event page tests that check specific table headers, colspan values, or `return_filter` hidden fields. Calendar/check-in page tests may need updates for new columns (Actions, check-in button, Address, Special Instructions, Ticket, Registered).
- `test/lib/server-checkin.test.ts`: Update for new `allowedDomain` parameter and new columns appearing in check-in page output.
- `test/lib/server-attendees.test.ts`: Update for `return_url` support in route handlers.
- `test/lib/server-calendar.test.ts`: Update for new Checked In button and Actions columns.

## Files Changed

| File | Change |
|------|--------|
| `src/templates/attendee-table.tsx` | **NEW** — Unified component + types + `formatAddressInline` |
| `src/templates/admin/events.tsx` | Remove old row/button; use `AttendeeTable`; re-export `formatAddressInline` |
| `src/templates/checkin.tsx` | Remove old row; use `AttendeeTable`; add `allowedDomain` param |
| `src/templates/admin/calendar.tsx` | Remove old row; use `AttendeeTable`; add `hasPaidEvent` to type |
| `src/routes/checkin.ts` | Pass `getAllowedDomain()` to template |
| `src/routes/admin/calendar.ts` | Add `hasPaidEvent` to `CalendarAttendeeRow` rows |
| `src/routes/admin/attendees.ts` | Add `redirectOrReturn` helper + `return_url` support to all handlers |
| `src/templates/admin/attendees.tsx` | Add `returnUrl` param to confirmation page templates |
| `test/lib/attendee-table.test.ts` | **NEW** — Comprehensive unit tests |
| `test/lib/html.test.ts` | Adjust for unified table output |
| `test/lib/server-checkin.test.ts` | Adjust for new columns/params |
| `test/lib/server-attendees.test.ts` | Adjust for `return_url` handling |
| `test/lib/server-calendar.test.ts` | Adjust for new columns |

## Verification

1. `deno task test` — All tests pass
2. `deno task test:coverage` — 100% coverage maintained
3. `deno task precommit` — Typecheck + lint + tests all pass
4. Manual check: each view (event detail, check-in, calendar) renders the same columns in the same order, with appropriate columns hidden
5. Manual check: clicking actions on check-in/calendar pages redirects back to the originating page after the action completes
