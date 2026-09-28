# Partial check-in: count the tickets a door admits

## Current-system value

A door records an arrival as all or nothing. A booking that holds three tickets
records three arrivals when only two people arrive. The pages that count
arrivals then report numbers that no door observed.

Production paths that receive the change:

- `POST /admin/listing/:id/scan` and `POST /admin/groups/:id/scan` (the door)
- `POST /checkin/:tokens` (the QR check-in page)
- `GET` + `POST /admin/listing/:listingId/attendee/:attendeeId/checkin` (the
  roster link gains a quantity page)
- The readers that count arrivals: listing and group detail rows, the roster
  filters, CSV export, and the admin API attendee answer

## Trusted facts

- `listing_attendees.quantity` is application data. Only booking paths write it,
  and only with the setup and capacity rules behind them.
- `checked_in` stores 0 or 1 today. It stores a count of admitted tickets after
  this change.
- Every browser input is untrusted: the scan JSON body, the form fields, and the
  hidden return fields. Parse each one. Reject a quantity that is not a positive
  whole number.
- A decrypted attendee row is application data, read under the request key.

## Valid states

For every row: `0 <= checked_in <= quantity`. A row with quantity 0 stores
checked_in 0. A read that finds a value outside these bounds reports a data
fault. The admit write itself caps at `quantity`, so concurrent writes cannot
break the bound.

## Commands and events

`c` is the stored count, `q` the line quantity, `r = q - c` the remaining
tickets.

| Starting state   | Command                      | Required result                                                                       |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `r = 0`          | Door scan                    | Answer `already_checked_in`. Write nothing.                                           |
| `r = 1`          | Door scan                    | Admit 1. Answer `checked_in`.                                                         |
| `r > 1`          | Door scan, no quantity field | Answer `select_quantity` with `max = r`. Write nothing.                               |
| `r > 1`          | Door scan, quantity `N`      | `c' = min(q, c + N)`. Answer `checked_in` with the admitted count and the line total. |
| `q > 1`, `r > 0` | Roster "Check In" link       | Open the quantity page. The select offers 1 to `r`.                                   |
| `q > 1`, `c > 0` | Roster "Check Out" link      | Open the quantity page. The select offers 1 to `c`.                                   |
| `q = 1`          | Roster button                | Direct admit or check out, as today.                                                  |
| any `c`          | "Check Out All" (QR page)    | Every live line goes to 0.                                                            |
| any `c`          | QR page "Check In All"       | Every live line goes to full.                                                         |

A roster line that is partly admitted offers both links, because a door can owe
tickets and release tickets on the same line. A quantity 1 line keeps the direct
toggle and the `Checked <name> in` flash wording, so the journey an in-flight
roster Feature pins stays as it is.

A door that scans one ticket across a group door keeps its rule: the chosen
count admits on each listing the scan covers, capped by what that listing still
owes.

## Failure table

| Work completed          | Failure                                      | Required result                                            | Retry owner          |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------- | -------------------- |
| Nothing                 | Quantity is absent, not a number, or below 1 | Scan: 400 answer. Form: redirect with a message. No write. | Caller               |
| Admit write             | Database error                               | The admit and its activity rows roll back together         | The door scans again |
| Two doors admit at once | None                                         | Each admit adds its count. The SQL cap holds the bound.    | None                 |

## Retry and replay

A scan adds tickets. A repeat scan adds more, up to `q`. A full line answers
`already_checked_in` and writes nothing. No idempotency key exists because no
money moves. The camera keeps its two second cooldown, so one wave of a hand
cannot admit twice.

## Concurrency

- Two admits on one line: one `UPDATE` each. The write lock serialises them. The
  statement `checked_in = MIN(quantity, checked_in + ?)` holds the bound.
- A check-out that races an admit: the last write wins. A check-out is an
  explicit operator action, so no revision check is needed.

## Owner choices

None. No money moves and no data merges. The display choices below are operator
wording, not owner decisions.

## Security and privacy

- The scan API keeps its scanner-level auth. The quantity page uses the same
  guard as the check-in POST route.
- `quantity` is untrusted input. The admit accepts 1 and above, and the SQL cap
  bounds it. A non-number or a value below 1 fails closed.
- No new personal data moves. The change stores and shows counts only.

## Shared contract

- One write in `src/shared/db/attendees/update.ts`: `moveTickets` moves `count`
  tickets in one direction — admit caps at
  `checked_in = MIN(quantity, checked_in + ?)`, release floors at
  `checked_in = MAX(0, checked_in - ?)`. The boolean helpers `updateCheckedIn`
  and `updateCheckedInOnListings` are deleted.
- `Attendee.checked_in` becomes a number in every view builder.
- One pure helper builds the choice list 1 to N. The quantity page and the scan
  answer both use it. The camera overlay builds the same list from the `max` the
  answer carries.
- The scan answer gains `status: "select_quantity"` with `max`, and the
  `checked_in` answer gains the admitted count and the line total.
- A roster toggle posts an explicit `check_in` field, so the direction a button
  means never depends on the line's stored state.

## Migration

`2026-09-27_checked_in_count` runs one statement:

```sql
UPDATE listing_attendees
SET checked_in = CASE WHEN quantity > 0 THEN quantity ELSE 0 END
WHERE checked_in = 1
```

Every line an operator marked as arrived held its full quantity in practice,
because the old flag cannot record less. The statement is idempotent. The legacy
restore path maps a stored `1` to `quantity` in the same way, so an old backup
restores to count semantics.

## Readers that change from flag math to count sums

- `listing-overview-stats.ts`: people checked in sums `checked_in` for confirmed
  rows. Ticket lines checked in count rows with `checked_in > 0`.
- `detail-rows.tsx`: `countCheckedIn` sums the counts. `countCheckedInRows`
  counts lines with a count above zero.
- The roster filter calls a line "Checked In" only when every ticket on it is
  admitted. A partly admitted line stays under "Checked Out", so the door can
  filter for people who still owe tickets.
- The CSV export shows the count itself in the "Checked In" column, so a part
  booking reads 2 and not a bare word. The admin API attendee answer carries the
  count for the same reason.

## Tests

- Migration: a stored 1 becomes `quantity`. A stored 0 stays 0. A quantity 0 row
  stays 0.
- Write pair: admit adds and caps. Release subtracts and stops at 0. A quantity
  0 line never admits.
- Scan decision: `select_quantity` when more than one ticket remains, direct
  admit when one remains, `already_checked_in` when none remain.
- Scan API: the JSON contract with and without `quantity`.
- QR page: full admit, partial state after admit, check-out.
- Quantity page: each direction offers its own range, the POST moves the count,
  an invalid quantity fails closed.
- Readers: a line with 2 of 3 admitted reports 2. This is the regression that
  proves the flag math is gone.
- Roster filters: a partly admitted line reads as Checked Out. CSV shows the
  count. The admin API example carries the count.
- The door Features gain a journey that admits part of a booking.

## What landed, and where

The code below is the authority now. This section only points at it.

| Concern             | Files and exported names                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| The count write     | `moveTickets(direction, attendeeId, listingId, count, tx?)` in `src/shared/db/attendees/update.ts`                                             |
| The owed rule       | `remainingTickets` in `src/shared/booking/remaining-tickets.ts`                                                                                |
| The scan rule       | `decideScan` with the `DoorAsk` object in `src/features/admin/scan-decision.ts`                                                                |
| The scan routes     | `src/features/admin/scanner.ts` (`select_quantity` answer, per-unit admission)                                                                 |
| The door asks       | `showQuantitySelect` in `src/ui/client/quantity-select.ts`, shared by `scanner.js` and `manual-checkin.ts`                                     |
| The roster controls | `CheckinControls` in `src/ui/templates/attendee-table/status.tsx`                                                                              |
| The quantity page   | `src/features/admin/attendees-checkin-routes.ts` with `attendeeCheckinQuantityPage` in `src/ui/templates/admin/attendees/checkin-quantity.tsx` |
| The count migration | `src/shared/db/migrations/2026-09-27_checked_in_count.ts`                                                                                      |
| The reader sums     | `src/shared/db/listing-overview-stats.ts`, `countCheckedIn` in `src/ui/templates/admin/detail-rows.tsx`                                        |

Two details differ from the contract's first draft, both simpler than it:

- The write pair became one `moveTickets` call with a direction word, because
  the two statements differed only in their SQL arms.
- The roster's Check In button posts an explicit `check_in` field, so a press
  never depends on the stored state to name its direction.

## Pull request shape

One pull request. The count meaning, its writers, and its readers must move
together. A slice that ships the column first leaves main reading a count as a
flag.
