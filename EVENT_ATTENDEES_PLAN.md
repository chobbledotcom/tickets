# EVENT_ATTENDEES_PLAN.md — Remaining Multi-Event Work

## What's done

- **Schema**: `event_attendees` table with `start_at`/`end_at` datetime ranges, per-event `checked_in_v2`/`refunded_v2`/`price_paid_v2`. Deprecated columns dropped from `attendees`.
- **Atomic insert**: `createAttendeeAtomic` accepts `bookings: EventBooking[]`, creates one attendee + N event_attendees rows in a single ACID batch with per-event capacity checks.
- **Booking flows**: `processFreeReservation` and webhook callback create one attendee per multi-event registration. `ensureAllBookings` enforces all-or-nothing semantics.
- **Per-event status writes**: `updateCheckedIn(attendeeId, eventId, ...)` and `markRefunded(attendeeId, eventId)` update `event_attendees` rows.

## What's left

### Phase 4: Token resolution returns multiple entries per attendee

**Problem**: `getAttendeesByTokens` LEFT JOINs `event_attendees` and builds a Map by `ticket_token_index`. With multiple `event_attendees` rows per attendee, the Map overwrites — only the last event survives. Downstream, `resolveEntries` assumes one event per attendee. The ticket page, success page, check-in page, and wallet passes all show only one event.

**Split into two sub-phases for safer merge path:**

#### Phase 4a: Data/API refactor

1. **`getAttendeesByTokens`** (`src/lib/db/attendees.ts`): Split into two queries:
   - Query 1: `SELECT ... FROM attendees WHERE ticket_token_index IN (?)` — get attendee rows (no event join)
   - Query 2: `SELECT * FROM event_attendees WHERE attendee_id IN (?)` — get all event links
   - Return new type: `AttendeeWithBookings = { attendee: AttendeeBase; bookings: EventAttendeeRow[] }`
   - Preserve input token order and sort bookings deterministically (by `start_at` then `event_id`) to avoid UI flicker across reloads

2. **New types** (`src/lib/db/attendee-types.ts`):
   - `EventAttendeeRow`: `{ event_id, start_at, end_at, quantity, checked_in_v2, refunded_v2, price_paid_v2 }`
   - `AttendeeWithBookings`: `{ attendee: AttendeeBase; bookings: EventAttendeeRow[] }`
   - Keep existing `Attendee` type (which carries single event_id/date/quantity) for backward compat in templates. Downstream consumers that need multi-event use `AttendeeWithBookings`.

3. **`resolveEntries`** (`src/routes/token-utils.ts`): Takes `AttendeeWithBookings[]`, returns `TokenEntry[]` — one entry per (attendee, event) pair. Batch-fetch events by ID to avoid N+1 queries (`getEventWithCount` is already cached, but validate).

4. **Invariant tests** (add before touching routes):
   - One token → N entries for multi-event attendee
   - Duplicate token in input → deduplicated, no double check-in/render
   - Booking order is deterministic across calls
   - Attendee with zero event links → still returned (not silently dropped)

#### Phase 4b: Route consumer updates

5. **Ticket view page** (`src/routes/tickets.ts`): Already iterates `entries` — should work once `resolveEntries` returns multiple entries per attendee.

6. **`renderSuccessFromTokens`** (`src/routes/webhooks.ts`): Collect ALL event_ids from all bookings across all attendees. Only show `thank_you_url` if all events share the same URL. Normalize URLs before comparison (trim trailing slash/whitespace).

7. **Check-in page** (`src/routes/checkin.ts`): Currently calls `resolveEntries` and renders one row per entry. With multi-event entries this naturally shows multiple rows. POST handler already uses `a.event_id` per entry — verify it correctly maps to the right `event_attendees` row.

8. **Scanner** (`src/routes/admin/scanner.ts`): Currently compares `attendee.event_id !== id`. Replace with direct event_attendees query: check if ANY of the attendee's bookings match the scanned event ID. When `force=true`, resolve the exact `(attendee, scanned_event)` link first — don't silently check in the wrong link.

9. **Wallet passes** (`src/routes/wallet.ts`, `src/routes/google-wallet.ts`):
   - **Decision**: One pass per event. Add event-scoped route: `/wallet/:token/:eventId.pkpass`
   - Since all phases ship together, old single-token route can redirect or serve primary event. No intermediate migration needed.
   - Update ticket page to render one wallet button per event entry

### Phase 6: Safe deleteEvent

**Problem**: `deleteEvent` collects attendee IDs from `event_attendees` and deletes those attendee rows entirely. If an attendee is linked to other events, those links (and the attendee record) are destroyed.

**Changes needed:**

1. **`deleteEvent`** (`src/lib/db/events.ts`): All in one transaction:
   - Collect attendee IDs from `event_attendees` for this event
   - Delete `event_attendees` rows for this event
   - Delete event-scoped dependent data:
     - `processed_payments` — scoped by attendee IDs from this event only
     - `attendee_answers` — scoped by attendee IDs from this event only. **Footgun**: these are attendee-global (not event-scoped). Only delete if the attendee has no other event links remaining.
   - Delete orphaned attendees: `DELETE FROM attendees WHERE id IN (?) AND NOT EXISTS (SELECT 1 FROM event_attendees WHERE attendee_id = attendees.id)`
   - Delete activity log and event

   **Key**: Orphan check + unlink must be in one transaction to prevent race orphaning under concurrent admin actions.

2. **`deleteAttendee`** (`src/lib/db/attendees.ts`): Unchanged — explicit "delete this person entirely" operation, removing all event links.

3. **New: `unlinkAttendeeFromEvent(attendeeId, eventId)`**: For admin UI to remove a single event link without deleting the attendee. Single transaction:
   - Delete the specific `event_attendees` row
   - If attendee has zero remaining links, delete attendee + processed_payments + attendee_answers
   - Return whether attendee was fully deleted or just unlinked

4. **Tests**:
   - Attendee linked to A+B, delete event A → attendee survives, B link intact
   - Attendee linked only to A, delete event A → attendee cleaned up as orphan
   - Concurrent unlink doesn't leave dangling attendee

### Phase 7: Capacity-guarded updateAttendee + date handling

**Problem**: `updateAttendee` does an unconditional `UPDATE event_attendees SET event_id = ?, quantity = ? WHERE attendee_id = ?` — no capacity check, no date update, affects ALL event links. Admin edits can overbook.

**Changes needed:**

1. **Split `updateAttendee` into two functions**:
   - `updateAttendeePII(attendeeId, piiInput)` → just updates `pii_blob` on attendees table. Contact fields only.
   - `updateEventLink(attendeeId, eventId, { quantity, date })` → capacity-guarded UPDATE on the specific `event_attendees` row. **Do not reuse old `updateAttendee` signature anywhere** once split is introduced.

2. **`updateEventLink`** uses conditional UPDATE:
   ```sql
   UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
   WHERE attendee_id = ? AND event_id = ?
     AND (capacity check excluding this row's existing quantity) + ? <= max_attendees
     AND (group capacity check excluding this row)
   ```
   Returns `{ success: true } | { success: false; reason: "capacity_exceeded" }`

   **Footgun**: When doing capacity checks on update, EXCLUDE the current row's existing quantity from the occupancy calculation. Otherwise legitimate no-op edits (saving same quantity) will fail capacity check because the row counts itself.

3. **Date validation**: Any `start_at`/`end_at` edits must validate against event schedule constraints (bookable days, holidays, min/max days) for daily events. Use `getAvailableDates` for validation.

4. **Types** (`src/lib/db/attendee-types.ts`): New `UpdateAttendeePIIInput` (contact fields + payment_id/token for blob rebuild). Remove old `UpdateAttendeeInput`.

### Phase 8: Admin UI for managing event links + date picker

**Problem**: The edit page has a single event selector and quantity field. It doesn't show which events the attendee is linked to, doesn't support adding/removing links, and has no date picker for daily events.

**Changes needed:**

1. **Edit page data loading** (`src/routes/admin/attendees.ts`): `withEditAttendee` loads ALL event links for the attendee (via `AttendeeWithBookings`), plus available events for adding new links, plus available dates per daily event.

2. **Edit page template** (`src/templates/admin/attendees.tsx`): Restructure into sections:
   - **PII section**: Name, email, phone, address, special instructions (shared, one form). POST to `/admin/attendees/:id`
   - **Event links section**: Table of current event links showing:
     - Event name, date/time range, quantity, check-in status, refund status
     - "Remove" button per link
     - Inline quantity edit per link
   - **Add event link section**: Event picker + date picker (for daily events) + quantity

3. **Date picker for daily events**:
   - Use `getAvailableDates(event, holidays)` from `src/lib/dates.ts`
   - Render as `<select name="date">` with options filtered by JS when event selection changes
   - Embed `data-dates` JSON attribute for client-side filtering
   - **Server-side validation is mandatory** — never trust client-filtered values

4. **POST handlers** (one endpoint per mutation type):
   - `POST /admin/attendees/:id` → updates PII only (calls `updateAttendeePII`)
   - `POST /admin/attendees/:id/link` → adds new event link via **dedicated `addEventLink(attendeeId, booking)`** function (do NOT reuse `createAttendeeAtomic` — it has PII/blob/token semantics that don't apply to adding a link to an existing attendee)
   - `POST /admin/attendees/:id/unlink/:eventId` → removes event link (calls `unlinkAttendeeFromEvent`)
   - `POST /admin/attendees/:id/event/:eventId` → updates per-event quantity/date (calls `updateEventLink`)

5. **Remove advisory prechecks**: Drop `hasAvailableSpots` precheck from edit handler entirely. All capacity enforcement happens in the SQL write path. Advisory prechecks are TOCTOU-prone and create "green UI, red save" confusion.

6. **New: `addEventLink(attendeeId, booking)`**: Dedicated function for adding an event link to an existing attendee. Single capacity-checked INSERT into `event_attendees`. Does NOT create a new attendee or touch PII.

## Constraints and schema notes

- **Unique constraint**: Current index is `(event_id, attendee_id, start_at)`. This prevents duplicate bookings for the same event+attendee+timeslot but allows multi-event. Consider adding `UNIQUE(attendee_id, event_id)` if same-event duplicate links should be impossible (currently they're prevented only by the start_at component).
- **Idempotency**: Admin POST operations (link/unlink/edit) should handle retries gracefully — no 500s or duplicates on double-submit.
- **Transactional boundaries**: Every add/update/unlink/delete operation that touches both `event_attendees` and `attendees` must be in one transaction.

## Footguns to actively guard against

| Footgun | Where | Mitigation |
|---------|-------|------------|
| Map overwrite losing events | Phase 4 `getAttendeesByTokens` | Split queries, group by attendee, enforce `bookings[]` list type |
| Nondeterministic entry ordering | Phase 4 `resolveEntries` | Sort by `start_at` then `event_id` before returning |
| Scanner checking wrong event link | Phase 4 scanner | Resolve exact `(attendee, event)` link, not `attendee.event_id` |
| Wallet pass ambiguity | Phase 4 wallet | Explicit event context in route, keep old route as fallback |
| Old wallet URLs in receipts breaking | Phase 4 wallet | Old `/wallet/:token.pkpass` serves primary event or 404 |
| Deleting shared attendees on event delete | Phase 6 `deleteEvent` | Orphan-only delete in same transaction as unlink |
| Deleting attendee_answers for still-linked attendee | Phase 6 `deleteEvent` | Only delete answers for orphaned attendees |
| Race between unlink and concurrent insert | Phase 6 `unlinkAttendeeFromEvent` | Orphan check in same transaction |
| Capacity self-fail on no-op edits | Phase 7 `updateEventLink` | Exclude current row's quantity from occupancy calc |
| Broad `WHERE attendee_id = ?` without event_id | Phase 7 | Every per-event mutation includes `(attendeeId, eventId)` in key |
| Reusing `createAttendeeAtomic` for link adds | Phase 8 | Dedicated `addEventLink` — no PII/blob/token creation |
| Advisory precheck disagrees with write guard | Phase 8 | Remove advisory prechecks entirely |
| Client-only date filtering trusted on save | Phase 8 | Server-side date validation mandatory |
| N+1 event lookups in resolveEntries | Phase 4 | Batch-fetch events by ID (cache is already in place) |
| Duplicate token in URL causing double operations | Phase 4 | Dedupe tokens before processing |

## Deployment note

All phases ship together — no intermediate deployments. This means we do NOT need backward-compatible transitional states for wallet routes, token resolution, or admin UI. Old single-event behavior can be replaced outright.

## Order of implementation

Phase 4a → Phase 4b → Phase 6 → Phase 7 → Phase 8

Phase 4 is highest priority (customer-visible correctness). Split into data layer (4a) then route consumers (4b) for safer merge. Phase 6 before 7 (safety before features). Phase 8 last (UI after APIs are safe).

## Files impacted (by phase)

| Phase | Files |
|-------|-------|
| 4a | `src/lib/db/attendees.ts`, `src/lib/db/attendee-types.ts`, `src/routes/token-utils.ts` |
| 4b | `src/routes/tickets.ts`, `src/routes/webhooks.ts`, `src/routes/checkin.ts`, `src/routes/admin/scanner.ts`, `src/routes/wallet.ts`, `src/routes/google-wallet.ts` |
| 6 | `src/lib/db/events.ts`, `src/lib/db/attendees.ts` |
| 7 | `src/lib/db/attendees.ts`, `src/lib/db/attendee-types.ts` |
| 8 | `src/routes/admin/attendees.ts`, `src/templates/admin/attendees.tsx`, `src/lib/dates.ts`, `src/templates/fields.ts` |
