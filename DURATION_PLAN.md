# `duration_days` — Multi-day bookings for daily listings

## Goal

Let admins mark a daily listing as a fixed-length multi-day booking (e.g. a 3-day workshop, a weekend retreat, etc. A single ticket reserves the full range; price scales with days; availability is checked across every day in the range.

This is deliberately a **small, low-risk step** that (a) delivers a new capability to existing users (multi-day courses/retreats/rentals), and (b) lays the plumbing for a later "customer picks their own end date" feature by making the whole stack multi-day-aware.

## Codebase findings (April 2026 deep-dive)

These findings come from reading the current implementation and should guide scope decisions:

- There is no persistent "booking group" object after checkout. The payment/session path carries `items` + optional `date`; attendee writes are just `attendees` + `listing_attendees` rows. Group context is not stored on attendee bookings.
- "Groups" in this codebase are listing collections (`listings.group_id`) used for discovery, shared public pages, and optional aggregate capacity limits — not a long-lived booking container.
- Group capacity checks happen dynamically by listing membership (`listings.group_id`) during availability/insert checks, not via any attendee-side group foreign key.
- Public listing headers already render a single `Date:` line for dated listings; duration display should therefore be implemented as a date-range label there (not as a separate "duration" field).
- Range copy decision: use an **en dash (`–`)** in rendered ranges.

## Semantics (decisions)

- `duration_days INTEGER NOT NULL DEFAULT 1` on `listings`.
- Only meaningful for `listing_type = 'daily'`. Ignored for `standard` listings.
- **Inclusive** range: a 3-day booking starting Mon covers Mon, Tue, Wed.
  - `start_at = startDate @ 00:00Z`
  - `end_at   = (startDate + duration_days days) @ 00:00Z` (first midnight after the window)
  - Matches the existing 1-day semantic exactly (`end_at = start_at + 1 day`).
- Customer still picks a **single start date**. The system extends the end automatically.
- Price: `unit_price × quantity × duration_days`.
- Start dates are only offered when **every day in the resulting range** is bookable (not a holiday, within the `bookable_days` weekday mask, and within `minimum_days_before` / `maximum_days_after`).
- `duration_days` is always editable for daily listings. On save, we also update existing `listing_attendees.end_at` ranges for that listing so stored bookings stay consistent with the listing's current duration policy.

## Non-goals (explicitly out of scope)

- Customer-chosen end date (phase 2 — this plan's infra supports it).
- Per-day pricing tiers / discounts.
- Partial cancellation/refund of days.
- Calendar UI spreading a booking across multiple day cells (phase 2).
- CSV export end-date column (phase 2).

## Phases

Each phase is intended to be a shippable, typechecking, test-passing state.

---

### Phase 1 — Schema + type

**Files**
- `src/shared/db/migrations.ts` — add `["duration_days", "INTEGER NOT NULL DEFAULT 1"]` to `listings` table columns. Bump `LATEST_UPDATE` to `"add duration_days to listings"`.
- `src/shared/types.ts` — add `duration_days: number` to the `Listing` interface (~line 74–105).
- `src/shared/db/listings.ts` — add `duration_days: col.withDefault(() => 1)` to `rawListingsTable` (near `max_quantity`, ~line 149). Add `durationDays?: number` to `ListingInput` if it's a separate type.

**Tests**
- `test/lib/db.test.ts` — confirm an inserted listing round-trips `duration_days` (default 1, explicit value preserved).

---

### Phase 2 — DB: range helpers and per-day availability

This is the core correctness phase. Everything else rides on it.

**Files**
- `src/shared/db/attendees.ts`
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
  - `ListingBooking` type (in `attendee-types.ts`): add `durationDays?: number` (default 1).
  - `buildCapacityCheckedInsert(booking, ...)` — pass `booking.durationDays` into `dateToStartEnd` so `end_at` is correct. The capacity-check SQL (overlap: `ea2.start_at < ? AND ea2.end_at > ?`) works unchanged for range-vs-range overlap.
  - Add a reconciliation helper for duration edits (e.g. `recomputeListingBookingRanges(listingId, durationDays)`):
    - Updates `end_at` for existing rows where `listing_id = ?` and `start_at IS NOT NULL`.
    - Formula: `end_at = datetime(start_at, '+' || durationDays || ' days')` (or equivalent UTC-safe expression).
    - Runs in same transaction as listing update when duration changes.
  - `getDateAttendeeCount(listingId, date)` — unchanged; still checks a single day's load (this is what makes multi-day checks accurate).
- `src/shared/db/attendees.ts → checkBatchAvailability`
  - **Accuracy fix**: for each daily listing in the batch, if `duration_days > 1` expand to per-day checks.
  - Implementation: enumerate every day in `[startDate, startDate + duration_days)` and run the existing single-day capacity query for each. Fail if any day is over capacity.
  - Apply the same per-day expansion to **group capacity** checks (`groups.max_attendees`) so multi-day products cannot overflow group occupancy on later days in the range.
  - Parallelize with `Promise.all` across days × listings.
  - Why per-day vs. a single overlap-sum: when two existing bookings each cover a subset of the requested range but don't overlap each other, overlap-sum double-counts them on days they don't both occupy, producing false "sold out" errors. Per-day iteration is exact and short (typical ranges ≤14 days).
- `src/shared/db/attendees.ts → buildCapacityCondition`
  - The inline SQL capacity check runs inside the atomic insert. For a multi-day booking, the simplest safe approach: JS-side per-day `hasAvailableSpots`-style check happens before the insert (already done via `checkBatchAvailability` in `ticket-payment.ts`); the inline SQL check remains the overlap-sum as a safety net. Over-rejection in the insert is safe (just triggers user retry) and race-condition rare.
  - Document this in a comment above `buildCapacityCondition`.

**Tests**
- `test/lib/db.test.ts`
  - `dateToRange("2026-04-15", 1)` → 2026-04-15..2026-04-16
  - `dateToRange("2026-04-15", 3)` → 2026-04-15..2026-04-18
  - `checkBatchAvailability` rejects when **any** day in a multi-day range is at capacity (even if adjacent days have space)
  - `checkBatchAvailability` accepts when all days have room
  - Group max-attendees per-day enforcement: Saturday/Sunday/combo scenario never exceeds day occupancy of 100
  - `createAttendeeAtomic` stores `end_at = start_at + duration × 86_400_000 ms` for a duration-3 listing
  - duration edit reconciliation updates existing rows' `end_at` for that listing

---

### Phase 3 — Admin form field

**Files**
- `src/templates/fields.ts`
  - Add `duration_days: number | null` to `ListingFormValues` (~line 44–67).
  - Add a field in `listingFields` after `maximum_days_after` (~line 380–386): label "Booking duration (days)", input `type="number"`, `min=1`, `max=90`, default `1`. Help text: "How many days each booking reserves. Only applies to daily listings."
  - Hide/disable when `listing_type !== 'daily'` — can piggyback on existing daily-only field visibility logic.
- `src/features/admin/listings.ts`
  - `extractCommonFields` / `extractListingUpdateInput` — parse `duration_days` (clamp ≥1), alongside `minimum_days_before`.
  - On listing edit save: if `duration_days` changed and listing is daily, call the DB reconciliation helper in the same transaction.
- `src/templates/admin/listings.tsx`
  - Admin listing detail view: show duration alongside min/max days so staff can verify booking behavior.
  - Listing edit form JS warning flow:
    - If duration value differs from persisted value, show warning label:
      `"Changing booking duration will update existing bookings for this listing."`
    - Show a confirmation input/checkbox gate before enabling Save.
    - Keep warning hidden when duration is unchanged.
- `src/templates/admin/attendees.tsx` / `src/templates/admin/attendee-table.tsx` / attendee edit template
  - When editing attendee listing links for daily bookings, show both start and end dates (or compact range) to make duration-impacted edits explicit.
  - When admin changes a booking date manually, recompute and persist end date using current listing duration.

**Tests**
- `test/lib/forms/listing-fields.test.ts` — parse/validate `duration_days` (reject 0, negative, non-integer).
- `test/admin-api-listings.test.ts` / `test/templates/admin/listings.test.ts` — create a daily listing with duration 3 and confirm it persists.
- `test/templates/admin/listings.test.ts` — warning/confirmation UI appears only when duration value changes.
- `test/admin-attendee-edit.test.ts` (or equivalent) — attendee edit view renders date ranges and persists recomputed end date.

---

### Phase 4 — Booking flow: price + bookable-start-date filter

**Files**
- `src/shared/dates.ts`
  - Update `getAvailableDates` to also filter out start dates whose range would extend past `end` or include a non-bookable day.
  - New helper (internal): `isRangeBookable(start, durationDays, bookableDays, holidays, endLimit)` — all days in `[start, start+duration)` must pass `isBookable` and be ≤ `endLimit`.
  - `getAvailableDates(listing, holidays)` reads `listing.duration_days` and applies the range filter.
  - `getNextBookableDate` — same filter.
- `src/features/public/ticket-payment.ts`
  - `buildRegistrationItems` — when the listing is daily with `duration_days > 1`, multiply `unitPrice` by `duration_days`. (The per-ticket item price the payment provider sees becomes the total per-ticket charge.)
  - `buildBookings` — include `durationDays: listing.duration_days` in the booking object so the DB insert uses the correct range.
- `src/features/public/ticket-form.ts`
  - `parseCustomPrice` / pay-more validation — the customer-entered price is **per-day**. Multiply by `duration_days` when validating against `max_price`? Or treat `max_price` as already-per-day? **Decision**: `unit_price` and `max_price` are per-day values; UI labels reflect that. Validation checks the per-day value as today; the final charge is `customPrice × duration_days × quantity`.
- `src/templates/public.tsx`
  - Near price display for daily listings with duration>1, show "£X/day × N days = £Y".
  - On listing detail pages, if the listing has a concrete start date (or is a daily listing where booking resolves a concrete range), show a single date-range line as `<from> to <to>`.
  - `renderPayMoreInput` — label hint: "Price per day…" when duration>1.

**Tests**
- `test/lib/dates.test.ts` — `getAvailableDates` for a duration-3 listing excludes start dates where day+2 is a holiday.
- `test/lib/server-public.test.ts`
  - Price quoted to payment provider is `unit_price × qty × duration_days`.
  - Booking row stored with correct `end_at`.
  - Pay-more min/max validated as per-day value.

---

### Phase 5 — Display: confirmation page, email, admin views

**Files**
- `src/shared/dates.ts`
  - Add `formatDateRangeLabel(startIso, endIso)` for booking records, returning a human range; single-day collapses to `formatDateLabel`.
  - Add English-only compact date-range formatter for listing/ticket display (for now), using **en dash** style rules:
    - Same day: `2 February 2027`
    - Same month + same year: `2–3 February 2027`
    - Different month + same year: `2 February – 3 March 2027`
    - Different year: `2 February 2027 – 3 February 2028` (no dedupe across years)
  - Keep this as a dedicated helper (e.g. `formatDateRangeLabelCompactEn`) so i18n can later replace locale behavior cleanly.
- `src/templates/public.tsx`
  - Reuse the compact formatter for the public listing/date line so UI shows an explicit range when available, with en dash-separated labels.
- `src/templates/tickets.tsx` — `attendeeDateHtml` (~line 57–59): render range when `attendee.end_at - attendee.start_at > 1 day`. Keep existing behaviour for single-day.
- `src/shared/email-renderer.ts` — template data exposes `dateRangeLabel` alongside `date` (kept for backward compatibility).
- `src/templates/admin/attendees.tsx` / `attendee-table.tsx` — date column shows range when multi-day (small visual tweak; row still sorts by start).
- `src/templates/admin/calendar.tsx` — **deferred** (still shows start date only; acceptable for v1).

**Tests**
- `test/lib/dates.test.ts` — `formatDateRangeLabel` for 1-day and multi-day cases.
- `test/lib/dates.test.ts` — compact English formatter coverage for same-day / same-month / same-year-different-month / cross-year cases.
- `test/templates/...` — snapshot/render tests update where dates appear.

---

### Phase 6 — Regression + integration

**Files**
- `test/e2e/*` / `test/integration/*` — add one end-to-end flow: create daily listing with duration=3, customer books start date, confirm stored range, confirm email + confirmation page show range, confirm capacity blocks a second overlapping booking when max reached.

---

## Group bookings interaction plan (deep-dive)

This feature intersects with group behavior in ways that are easy to miss. We should treat this as first-class planning work, not a follow-up.

### Group semantics to lock in

- `duration_days` is **listing-scoped**, not attendee-scoped: all tickets in one checkout for a daily listing inherit the same date range from the selected start date.
- Capacity is checked against **total attendee quantity per day** across the full range, regardless of whether tickets are bought as a group or individually.
- Group identity is `listings.group_id` membership, not attendee booking linkage: changing duration on the listing affects only future attendee rows via future inserts.

### DB + atomicity details for multi-listing/group-page checkouts

- For one checkout that creates multiple `listing_attendees` rows:
  - Compute a single `{ start_at, end_at }` from `date + duration_days` for each daily listing booking being inserted.
  - Keep the existing overlap predicate (`ea2.start_at < ? AND ea2.end_at > ?`) for atomic safety.
  - Run preflight per-day availability for the **full requested quantity** before insert to avoid partial success outcomes where some booking rows insert and others fail.
- If current implementation inserts one attendee at a time, verify ordering/rollback behavior:
  - Prefer all-or-nothing transaction semantics for multi-row booking writes.
  - Ensure payment finalization does not leave orphaned partial attendee links when capacity races occur.

### Availability math with groups (nitty-gritty cases)

For each day in range `D = [start, start + duration)`:

- Effective demand added by booking = `quantity`.
- Day is valid iff `existingAttendeesForDay + quantity <= max_quantity`.
- Reject booking if **any** day fails this predicate.
- For groups with `max_attendees > 0`, apply the same predicate to **group-day occupancy**:
  - `existingGroupAttendeesForDay + requestedInGroupForDay <= group.max_attendees`
  - This must be evaluated for each day in the booking range, not only the selected start date.

Edge cases to explicitly test:

1. Day 1 has room, Day 2 is full, Day 3 has room → entire checkout booking for that listing must fail.
2. Two concurrent checkouts for same range near capacity → only one should commit.
3. Existing long booking overlaps only tail of requested range; another overlaps head; per-day checks should accept/reject correctly without overlap-sum false positives.
4. Mixed cart with multiple daily listings (different durations) and at least one grouped quantity >1.
5. Group-level day cap with mixed products (single-day + combo) rejects any booking that would push either day over the group limit.

### Concrete occupancy scenario to verify (must pass)

Group setup:

- One group with `group.max_attendees = 100`.
- Three daily listings in that group, each with `listing.max_attendees = 100`:
  1. Saturday session (`duration_days = 1`)
  2. Sunday session (`duration_days = 1`)
  3. Saturday+Sunday combo (`duration_days = 2`, start on Saturday)

Expected behavior:

- Booking Saturday-only should consume Saturday occupancy only.
- Booking Sunday-only should consume Sunday occupancy only.
- Booking combo should consume both Saturday and Sunday occupancy.
- At any time, neither day's group occupancy can exceed 100.

Implementation requirement:

- During availability + atomic insert safety checks, compute per-day occupancy for:
  - listing-level caps, and
  - group-level caps
  across the entire requested range.
- If any day in range would exceed 100 at group level, reject the booking even if listing-level cap for the chosen product appears available.

### UX/content implications for group flows

- Public listing page: show explicit date range text when a concrete range can be determined, using en dash style.
- Ticket/checkout summaries should still make total pricing transparent (`per-day × duration × quantity`) so group organizers can reconcile totals.
- Confirmation/email should show the resolved date range once booked; that is sufficient for group participants.

### Suggested implementation placement

- Phase 2: include group-aware per-day capacity checks (listing + group limits) at DB/service layer.
- Phase 4: include mixed-cart + grouped-quantity pricing checks.
- Phase 6: e2e scenario should use `quantity > 1` to validate true group path, not only single-ticket happy path; include Saturday/Sunday/combo occupancy assertions.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Over-rejection from overlap-sum in atomic insert (race window) | JS-side per-day check in `checkBatchAvailability` is primary; SQL overlap-sum is safety net. Document. |
| Existing listings silently change behaviour | Default `duration_days = 1` is a strict no-op for every existing row. |
| Editing duration rewrites historical/future ranges unexpectedly | Require explicit UI warning + confirmation before save; run update in one transaction and log admin action. |
| Price regression for existing paid daily listings | Multiplier only applies when `duration_days > 1`; 1 × price is a no-op. Covered by test. |
| Webhook/provider metadata `date` field is single-date | No change — still stores start date. Duration re-read from listing at finalize time (duration is listing-scoped, not booking-scoped). |
| Admin accidentally sets duration on `standard` listing | Ignored by booking logic. Optional: hide field in admin UI for standard listings. |
| Holidays / bookable-days mask intersect badly with long durations | `getAvailableDates` filter ensures unbookable start dates aren't offered. |

## File-change summary (estimated)

| Area | Files | Notes |
|---|---|---|
| Schema | `migrations.ts`, `listings.ts` (db), `types.ts` | 1 column, 1 type field |
| DB logic | `attendees.ts`, `attendee-types.ts` | `dateToRange`, `ListingBooking`, per-day availability |
| Admin form | `fields.ts`, `routes/admin/listings.ts`, `templates/admin/listings.tsx` | 1 new field |
| Booking flow | `dates.ts`, `ticket-payment.ts`, `ticket-form.ts`, `public.tsx` | Filter + price multiplier |
| Display | `dates.ts`, `tickets.tsx`, `email-renderer.ts`, `attendee-table.tsx` | Date range formatting |
| Tests | ~6 test files | Mostly additive |

Roughly **8–10 source files**, **5–7 test files**.

## Resolved decisions (April 2026)

1. `duration_days` is always editable for daily listings, and saving a changed value updates existing bookings for that listing.
2. Maximum `duration_days` is **90**.
3. Admin UI must show explicit warning + confirmation when duration is changed.
4. Because duration edits rewrite booking ranges, attendee-edit surfaces should show start/end (range) rather than start-only for daily bookings.

## Phase 2 kickoff

Start with Phase 1 (smallest, unblocks everything). Each subsequent phase typechecks cleanly on its own because earlier phases default behaviour to the existing 1-day semantic.
