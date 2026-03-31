# EVENT_ATTENDEES_PLAN.md — Remaining Multi-Event Work

## What's done

- **Schema**: `event_attendees` table with `start_at`/`end_at` datetime ranges, per-event `checked_in_v2`/`refunded_v2`/`price_paid_v2`. Deprecated columns dropped from `attendees`.
- **Atomic insert**: `createAttendeeAtomic` accepts `bookings: EventBooking[]`, creates one attendee + N event_attendees rows in a single ACID batch with per-event capacity checks.
- **Booking flows**: `processFreeReservation` and webhook callback create one attendee per multi-event registration. `ensureAllBookings` enforces all-or-nothing semantics.
- **Per-event status writes**: `updateCheckedIn(attendeeId, eventId, ...)` and `markRefunded(attendeeId, eventId)` update `event_attendees` rows.

## What's left

### Phase 4: Token resolution returns multiple entries per attendee

**Problem**: `getAttendeesByTokens` LEFT JOINs `event_attendees` and builds a Map by `ticket_token_index`. With multiple `event_attendees` rows per attendee, the Map overwrites — only the last event survives. Downstream, `resolveEntries` assumes one event per attendee. The ticket page, success page, check-in page, and wallet passes all show only one event.

**Changes needed:**

1. **`getAttendeesByTokens`** (`src/lib/db/attendees.ts:656-679`): Split into two queries:
   - Query 1: `SELECT ... FROM attendees WHERE ticket_token_index IN (?)` — get attendee rows (no event join)
   - Query 2: `SELECT * FROM event_attendees WHERE attendee_id IN (?)` — get all event links
   - Return a new type: `AttendeeWithBookings = { attendee: Attendee; bookings: EventAttendeeRow[] }` (or similar)
   - Alternatively: keep single query but GROUP results in JS by attendee id

2. **New type `EventAttendeeRow`** (`src/lib/db/attendee-types.ts`): Raw row from `event_attendees` — `{ event_id, start_at, end_at, quantity, checked_in_v2, refunded_v2, price_paid_v2 }`

3. **`resolveEntries`** (`src/routes/token-utils.ts:115`): Takes `AttendeeWithBookings[]`, returns `TokenEntry[]` — one entry per (attendee, event) pair. Each entry is `{ attendee, event, booking }` where `booking` carries per-event quantity/status/dates.

4. **Ticket view page** (`src/routes/tickets.ts:41-63`): Already iterates `entries` — should work once `resolveEntries` returns multiple entries per attendee.

5. **`renderSuccessFromTokens`** (`src/routes/webhooks.ts:606-642`): Collect ALL event_ids from all bookings. Only show thank_you_url if all events share the same URL (or single event).

6. **Wallet passes** (`src/routes/wallet.ts`, `src/routes/google-wallet.ts`): Currently require single token → single event. With multi-event, one token has multiple events. Options:
   - Generate one pass per event (multiple passes from one token)
   - Generate one combined pass
   - Keep current: pass generation for the "primary" event only
   Decision: one pass per event is most correct. Route would need to accept event context, e.g. `/wallet/:token/:eventId.pkpass`.

7. **Check-in page** (`src/routes/checkin.ts`): Currently calls `resolveEntries` and renders one row per entry. With multi-event entries this should naturally show multiple rows. The POST handler already uses `a.event_id` per entry.

8. **Scanner** (`src/routes/admin/scanner.ts:92`): Currently compares `attendee.event_id !== id`. With multi-event, check if ANY of the attendee's bookings match the scanned event. Change from `attendee.event_id` lookup to querying event_attendees directly.

### Phase 6: Safe deleteEvent

**Problem**: `deleteEvent` collects attendee IDs from `event_attendees` and deletes those attendee rows entirely. If an attendee is linked to other events, those links (and the attendee record) are destroyed.

**Changes needed:**

1. **`deleteEvent`** (`src/lib/db/events.ts:214-246`):
   - Delete `event_attendees` rows for this event
   - Delete `processed_payments` for attendees of this event
   - Delete `attendee_answers` for attendees of this event
   - Delete attendees that have **zero remaining** `event_attendees` links (orphaned)
   - Delete activity log and event

   The orphan check: `DELETE FROM attendees WHERE id IN (?) AND NOT EXISTS (SELECT 1 FROM event_attendees WHERE attendee_id = attendees.id)`

2. **`deleteAttendee`** (`src/lib/db/attendees.ts:330-343`): This is fine — it's an explicit "delete this person entirely" operation, removing all event links.

3. **New: `unlinkAttendeeFromEvent`**: For the admin UI to remove a single event link without deleting the attendee. Deletes the `event_attendees` row, then deletes the attendee if orphaned.

### Phase 7: Capacity-guarded updateAttendee + date handling

**Problem**: `updateAttendee` does an unconditional `UPDATE event_attendees SET event_id = ?, quantity = ? WHERE attendee_id = ?` — no capacity check, no date update, affects ALL event links. Admin edits can overbook.

**Changes needed:**

1. **Rethink what "edit attendee" means in multi-event context**:
   - PII editing (name, email, phone, etc.) → applies to attendee row, shared across events
   - Per-event editing (quantity, date) → applies to specific `event_attendees` row
   - These are two different operations

2. **Split `updateAttendee` into two functions**:
   - `updateAttendeePII(attendeeId, piiInput)` → just updates `pii_blob` on attendees table
   - `updateEventLink(attendeeId, eventId, { quantity, date })` → capacity-guarded UPDATE on the specific `event_attendees` row

3. **`updateEventLink`** uses conditional UPDATE (like `createAttendeeAtomic`):
   ```sql
   UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
   WHERE attendee_id = ? AND event_id = ?
     AND (capacity check excluding this row) + ? <= max_attendees
   ```
   Returns `{ success: true } | { success: false; reason: "capacity_exceeded" }`

4. **`UpdateAttendeeInput`** (`src/lib/db/attendee-types.ts`): Split into `UpdateAttendeePIIInput` (contact fields + payment_id/token for blob rebuild) and per-event update params.

### Phase 8: Admin UI for managing event links + date picker

**Problem**: The edit page has a single event selector and quantity field. It doesn't show which events the attendee is linked to, doesn't support adding/removing links, and has no date picker for daily events.

**Changes needed:**

1. **Edit page data loading** (`src/routes/admin/attendees.ts:350-370`): `withEditAttendee` currently loads one event + one attendee. Needs to load ALL event links for the attendee, plus available events for adding new links.

2. **Edit page template** (`src/templates/admin/attendees.tsx:224-329`): Restructure into sections:
   - **PII section**: Name, email, phone, address, special instructions (shared, one form)
   - **Event links section**: Table of current event links showing:
     - Event name, date/time range, quantity, check-in status, refund status
     - "Remove" button per link (calls `unlinkAttendeeFromEvent`)
     - Quantity edit per link (inline or modal)
   - **Add event link section**: Event picker + date picker (for daily events) + quantity

3. **Date picker for daily events**:
   - Use `getAvailableDates(event, holidays)` from `src/lib/dates.ts` to build available dates per daily event
   - Render as `<select name="date">` with options filtered by JS when event selection changes
   - Embed `data-dates` JSON attribute for client-side filtering
   - Validate chosen date server-side on POST

4. **POST handlers**:
   - `POST /admin/attendees/:id` → updates PII only (calls `updateAttendeePII`)
   - `POST /admin/attendees/:id/link` → adds new event link (calls `createAttendeeAtomic` with existing attendee? Or a new `addEventLink` function)
   - `POST /admin/attendees/:id/unlink/:eventId` → removes event link (calls `unlinkAttendeeFromEvent`)
   - `POST /admin/attendees/:id/event/:eventId` → updates per-event quantity/date (calls `updateEventLink`)

5. **Capacity checks**: Each add/update operation uses capacity-guarded SQL. Remove the advisory `hasAvailableSpots` precheck from the edit handler.

## Order of implementation

Phase 4 → Phase 6 → Phase 7 → Phase 8

Phase 4 is the most impactful — it makes the multi-event model visible to users (ticket pages show all events, scanner correctly matches, etc.). Phases 6-7 are safety/correctness. Phase 8 is the admin UX.

## Files impacted (by phase)

| Phase | Files |
|-------|-------|
| 4 | `src/lib/db/attendees.ts`, `src/lib/db/attendee-types.ts`, `src/routes/token-utils.ts`, `src/routes/tickets.ts`, `src/routes/webhooks.ts`, `src/routes/checkin.ts`, `src/routes/admin/scanner.ts`, `src/routes/wallet.ts`, `src/routes/google-wallet.ts` |
| 6 | `src/lib/db/events.ts`, `src/lib/db/attendees.ts` |
| 7 | `src/lib/db/attendees.ts`, `src/lib/db/attendee-types.ts` |
| 8 | `src/routes/admin/attendees.ts`, `src/templates/admin/attendees.tsx`, `src/lib/dates.ts`, `src/templates/fields.ts` |
