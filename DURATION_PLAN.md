# `duration_days` — Multi-day bookings for daily events

## Goal

Let admins mark a daily event as a fixed-length multi-day booking (e.g. a 3-day workshop, a weekend retreat, equipment rented for 5 days). A single ticket reserves the full range; price scales with days; availability is checked across every day in the range.

This is deliberately a **small, low-risk step** that (a) delivers a new capability to existing users (multi-day courses/retreats/rentals), and (b) lays the plumbing for a later "customer picks their own end date" feature by making the whole stack multi-day-aware.

## Semantics (decisions)

- `duration_days INTEGER NOT NULL DEFAULT 1` on `events`.
- Only meaningful for `event_type = 'daily'`. Ignored for `standard` events.
- **Inclusive** range: a 3-day booking starting Mon covers Mon, Tue, Wed.
  - `start_at = startDate @ 00:00Z`
  - `end_at   = (startDate + duration_days days) @ 00:00Z` (first midnight after the window)
  - Matches the existing 1-day semantic exactly (`end_at = start_at + 1 day`).
- Customer still picks a **single start date**. The system extends the end automatically.
- Price: `unit_price × quantity × duration_days`.
- Start dates are only offered when **every day in the resulting range** is bookable (not a holiday, within the `bookable_days` weekday mask, and within `minimum_days_before` / `maximum_days_after`).

## Non-goals (explicitly out of scope)

- Customer-chosen end date (phase 2 — this plan's infra supports it).
- Per-day pricing tiers / discounts.
- Partial cancellation/refund of days.
- Admin edit of duration on existing bookings rewriting their ranges retroactively (new bookings pick up new duration; existing rows keep their stored range).
- Calendar UI spreading a booking across multiple day cells (phase 2).
- CSV export end-date column (phase 2).

## Phases

Each phase is intended to be a shippable, typechecking, test-passing state.

---

### Phase 1 — Schema + type

**Files**
- `src/lib/db/migrations.ts` — add `["duration_days", "INTEGER NOT NULL DEFAULT 1"]` to `events` table columns. Bump `LATEST_UPDATE` to `"add duration_days to events"`.
- `src/lib/types.ts` — add `duration_days: number` to the `Event` interface (~line 74–105).
- `src/lib/db/events.ts` — add `duration_days: col.withDefault(() => 1)` to `rawEventsTable` (near `max_quantity`, ~line 149). Add `durationDays?: number` to `EventInput` if it's a separate type.

**Tests**
- `test/lib/db.test.ts` — confirm an inserted event round-trips `duration_days` (default 1, explicit value preserved).

---

### Phase 2 — DB: range helpers and per-day availability

This is the core correctness phase. Everything else rides on it.

**Files**
- `src/lib/db/attendees.ts`
  - Extend `dateToRange` to accept an optional duration:
    ```ts
    export const dateToRange = (date: string, durationDays = 1) => {
      const startMs = new Date(`${date}T00:00:00Z`).getTime();
      const endIso = new Date(startMs + durationDays * 86_400_000).toISOString();
      return { startAt: `${date}T00:00:00Z`, endAt: endIso };
    };
    ```
    (Default preserves existing 1-day behaviour; no caller break.)
  - `dateToStartEnd(date, durationDays)` — thread duration through.
  - `EventBooking` type (in `attendee-types.ts`): add `durationDays?: number` (default 1).
  - `buildCapacityCheckedInsert(booking, ...)` — pass `booking.durationDays` into `dateToStartEnd` so `end_at` is correct. The capacity-check SQL (overlap: `ea2.start_at < ? AND ea2.end_at > ?`) works unchanged for range-vs-range overlap.
  - `getDateAttendeeCount(eventId, date)` — unchanged; still checks a single day's load (this is what makes multi-day checks accurate).
- `src/lib/db/attendees.ts → checkBatchAvailability`
  - **Accuracy fix**: for each daily event in the batch, if `duration_days > 1` expand to per-day checks.
  - Implementation: enumerate every day in `[startDate, startDate + duration_days)` and run the existing single-day capacity query for each. Fail if any day is over capacity.
  - Parallelize with `Promise.all` across days × events.
  - Why per-day vs. a single overlap-sum: when two existing bookings each cover a subset of the requested range but don't overlap each other, overlap-sum double-counts them on days they don't both occupy, producing false "sold out" errors. Per-day iteration is exact and short (typical ranges ≤14 days).
- `src/lib/db/attendees.ts → buildCapacityCondition`
  - The inline SQL capacity check runs inside the atomic insert. For a multi-day booking, the simplest safe approach: JS-side per-day `hasAvailableSpots`-style check happens before the insert (already done via `checkBatchAvailability` in `ticket-payment.ts`); the inline SQL check remains the overlap-sum as a safety net. Over-rejection in the insert is safe (just triggers user retry) and race-condition rare.
  - Document this in a comment above `buildCapacityCondition`.

**Tests**
- `test/lib/db.test.ts`
  - `dateToRange("2026-04-15", 1)` → 2026-04-15..2026-04-16
  - `dateToRange("2026-04-15", 3)` → 2026-04-15..2026-04-18
  - `checkBatchAvailability` rejects when **any** day in a multi-day range is at capacity (even if adjacent days have space)
  - `checkBatchAvailability` accepts when all days have room
  - `createAttendeeAtomic` stores `end_at = start_at + duration × 86_400_000 ms` for a duration-3 event

---

### Phase 3 — Admin form field

**Files**
- `src/templates/fields.ts`
  - Add `duration_days: number | null` to `EventFormValues` (~line 44–67).
  - Add a field in `eventFields` after `maximum_days_after` (~line 380–386): label "Booking duration (days)", input `type="number"`, `min=1`, `max=90`, default `1`. Help text: "How many days each booking reserves. Only applies to daily events."
  - Hide/disable when `event_type !== 'daily'` — can piggyback on existing daily-only field visibility logic.
- `src/routes/admin/events.ts`
  - `extractCommonFields` / `extractEventUpdateInput` — parse `duration_days` (clamp ≥1), alongside `minimum_days_before`.
- `src/templates/admin/events.tsx`
  - Admin event detail view: show duration alongside min/max days so staff can verify booking behavior.

**Tests**
- `test/lib/forms/event-fields.test.ts` — parse/validate `duration_days` (reject 0, negative, non-integer).
- `test/admin-api-events.test.ts` / `test/templates/admin/events.test.ts` — create a daily event with duration 3 and confirm it persists.

---

### Phase 4 — Booking flow: price + bookable-start-date filter

**Files**
- `src/lib/dates.ts`
  - Update `getAvailableDates` to also filter out start dates whose range would extend past `end` or include a non-bookable day.
  - New helper (internal): `isRangeBookable(start, durationDays, bookableDays, holidays, endLimit)` — all days in `[start, start+duration)` must pass `isBookable` and be ≤ `endLimit`.
  - `getAvailableDates(event, holidays)` reads `event.duration_days` and applies the range filter.
  - `getNextBookableDate` — same filter.
- `src/routes/public/ticket-payment.ts`
  - `buildRegistrationItems` — when the event is daily with `duration_days > 1`, multiply `unitPrice` by `duration_days`. (The per-ticket item price the payment provider sees becomes the total per-ticket charge.)
  - `buildBookings` — include `durationDays: event.duration_days` in the booking object so the DB insert uses the correct range.
- `src/routes/public/ticket-form.ts`
  - `parseCustomPrice` / pay-more validation — the customer-entered price is **per-day**. Multiply by `duration_days` when validating against `max_price`? Or treat `max_price` as already-per-day? **Decision**: `unit_price` and `max_price` are per-day values; UI labels reflect that. Validation checks the per-day value as today; the final charge is `customPrice × duration_days × quantity`.
- `src/templates/public.tsx`
  - Near price display for daily events with duration>1, show "£X/day × N days = £Y".
  - On event detail pages, if the event has a concrete start date (or is a daily event where booking resolves a concrete range), show a single date-range line as `<from> to <to>`.
  - `renderPayMoreInput` — label hint: "Price per day…" when duration>1.

**Tests**
- `test/lib/dates.test.ts` — `getAvailableDates` for a duration-3 event excludes start dates where day+2 is a holiday.
- `test/lib/server-public.test.ts`
  - Price quoted to payment provider is `unit_price × qty × duration_days`.
  - Booking row stored with correct `end_at`.
  - Pay-more min/max validated as per-day value.

---

### Phase 5 — Display: confirmation page, email, admin views

**Files**
- `src/lib/dates.ts` — add `formatDateRangeLabel(startIso, endIso)` → `"Mon 15 Apr – Wed 17 Apr"`. Single-day collapses to `formatDateLabel`.
  - Add English-only compact range formatter for event/ticket display (for now), with these rules:
    - Same day: `2 February 2027`
    - Same month + same year: `2–3 February 2027`
    - Different month + same year: `2 February – 3 March 2027`
    - Different year: `2 February 2027 – 3 February 2028` (no dedupe across years)
  - Keep this as a dedicated helper (e.g. `formatDateRangeLabelCompactEn`) so i18n can later swap locale-specific behavior without rewriting booking logic.
- `src/templates/public.tsx`
  - Reuse the compact formatter for the public event/date line so UI shows `<from> to <to>` semantics without awkward repeated month/year text.
- `src/templates/tickets.tsx` — `attendeeDateHtml` (~line 57–59): render range when `attendee.end_at - attendee.start_at > 1 day`. Keep existing behaviour for single-day.
- `src/lib/email-renderer.ts` — template data exposes `dateRangeLabel` alongside `date` (kept for backward compatibility).
- `src/templates/admin/attendees.tsx` / `attendee-table.tsx` — date column shows range when multi-day (small visual tweak; row still sorts by start).
- `src/templates/admin/calendar.tsx` — **deferred** (still shows start date only; acceptable for v1).

**Tests**
- `test/lib/dates.test.ts` — `formatDateRangeLabel` for 1-day and multi-day cases.
- `test/lib/dates.test.ts` — compact English formatter coverage for same-day / same-month / same-year-different-month / cross-year cases.
- `test/templates/...` — snapshot/render tests update where dates appear.

---

### Phase 6 — Regression + integration

**Files**
- `test/e2e/*` / `test/integration/*` — add one end-to-end flow: create daily event with duration=3, customer books start date, confirm stored range, confirm email + confirmation page show range, confirm capacity blocks a second overlapping booking when max reached.

---

## Group bookings interaction plan (deep-dive)

This feature intersects with group behavior in ways that are easy to miss. We should treat this as first-class planning work, not a follow-up.

### Group semantics to lock in

- `duration_days` is **event-scoped**, not attendee-scoped: all tickets in a group booking inherit the same date range from the selected start date.
- Capacity is checked against **total attendee quantity per day** across the full range, regardless of whether tickets are bought as a group or individually.
- Group identity (`group_id` or equivalent linkage) remains orthogonal to duration: changing duration on the event affects only future bookings, not existing group rows.

### DB + atomicity details for grouped inserts

- For grouped purchases that create multiple attendee rows in one transaction:
  - Compute a single `{ start_at, end_at }` from `date + duration_days` and reuse it for every row in the group.
  - Keep the existing overlap predicate (`ea2.start_at < ? AND ea2.end_at > ?`) for atomic safety.
  - Run preflight per-day availability for the **full requested quantity** before insert to avoid split-brain outcomes where some group members insert and others fail.
- If current implementation inserts one attendee at a time, verify ordering/rollback behavior:
  - Prefer all-or-nothing transaction semantics for group booking writes.
  - Ensure payment finalization does not leave orphaned partial groups when capacity races occur.

### Availability math with groups (nitty-gritty cases)

For each day in range `D = [start, start + duration)`:

- Effective demand added by booking = `quantity` (group size).
- Day is valid iff `existingAttendeesForDay + quantity <= max_quantity`.
- Reject booking if **any** day fails this predicate.

Edge cases to explicitly test:

1. Day 1 has room, Day 2 is full, Day 3 has room → entire group booking must fail.
2. Two concurrent group checkouts for same range near capacity → only one should commit.
3. Existing long booking overlaps only tail of requested range; another overlaps head; per-day checks should accept/reject correctly without overlap-sum false positives.
4. Mixed cart with multiple daily events (different durations) and at least one grouped quantity >1.

### UX/content implications for group flows

- Public event page: show explicit date range text (`<from> to <to>`) when a concrete range can be determined.
- Ticket/checkout summaries should still make total pricing transparent (`per-day × duration × quantity`) so group organizers can reconcile totals.
- Confirmation/email should show the resolved date range once booked; that is sufficient for group participants.

### Suggested implementation placement

- Phase 2: include group-aware per-day capacity tests at DB/service layer.
- Phase 4: include mixed-cart + grouped-quantity pricing checks.
- Phase 6: e2e scenario should use `quantity > 1` to validate true group path, not only single-ticket happy path.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Over-rejection from overlap-sum in atomic insert (race window) | JS-side per-day check in `checkBatchAvailability` is primary; SQL overlap-sum is safety net. Document. |
| Existing events silently change behaviour | Default `duration_days = 1` is a strict no-op for every existing row. |
| Price regression for existing paid daily events | Multiplier only applies when `duration_days > 1`; 1 × price is a no-op. Covered by test. |
| Webhook/provider metadata `date` field is single-date | No change — still stores start date. Duration re-read from event at finalize time (duration is event-scoped, not booking-scoped). |
| Admin accidentally sets duration on `standard` event | Ignored by booking logic. Optional: hide field in admin UI for standard events. |
| Holidays / bookable-days mask intersect badly with long durations | `getAvailableDates` filter ensures unbookable start dates aren't offered. |

## File-change summary (estimated)

| Area | Files | Notes |
|---|---|---|
| Schema | `migrations.ts`, `events.ts` (db), `types.ts` | 1 column, 1 type field |
| DB logic | `attendees.ts`, `attendee-types.ts` | `dateToRange`, `EventBooking`, per-day availability |
| Admin form | `fields.ts`, `routes/admin/events.ts`, `templates/admin/events.tsx` | 1 new field |
| Booking flow | `dates.ts`, `ticket-payment.ts`, `ticket-form.ts`, `public.tsx` | Filter + price multiplier |
| Display | `dates.ts`, `tickets.tsx`, `email-renderer.ts`, `attendee-table.tsx` | Date range formatting |
| Tests | ~6 test files | Mostly additive |

Roughly **8–10 source files**, **5–7 test files**.

## Open questions (to resolve during implementation, not now)

1. Should `duration_days` be editable after a daily event has bookings? (Default: yes, but existing bookings keep their stored ranges; new bookings use the new value.)
2. Max value — 90 (current `maximum_days_after` default) or 365? Probably 90.
3. Should we add explicit guardrails around editing duration when there are existing group bookings to reduce admin confusion?
4. Should the public event page use an en dash (`–`) vs literal `to` in the rendered range, and should this vary by template/context?

## Phase 2 kickoff

Start with Phase 1 (smallest, unblocks everything). Each subsequent phase typechecks cleanly on its own because earlier phases default behaviour to the existing 1-day semantic.
