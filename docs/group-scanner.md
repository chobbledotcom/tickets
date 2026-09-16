# Group scanner contract

Status: approved by the owner on 15 September 2026, with the three decisions
below recorded. Resolves
[#2377](https://github.com/chobbledotcom/tickets/issues/2377).

## Current-system value

Door staff who run an event group must open a separate listing scanner for each
admission tier in the group. One group scanner page, opened from the group's own
page, admits a ticket for any member of that group. The production routes that
receive the change are `GET /admin/groups/:id/scanner` and
`POST /admin/groups/:id/scan`, served by `src/features/admin/scanner.ts`.

## Trusted facts

| Fact                                     | Authority and use                                               |
| ---------------------------------------- | --------------------------------------------------------------- |
| Group id from the URL                    | Untrusted until `getGroupById` resolves it or the route 404s.   |
| Group membership                         | `getListingsByGroupId` rows are the admission scope.            |
| `listing.purchase_only`                  | A member marked "No check-in" is not an admission listing.      |
| `listing.hidden` and `active`            | Not admission facts. Hidden and inactive members stay in scope. |
| `groups.scan_checks_in_all_listings`     | The stored per-group door preference this change adds.          |
| Scanned token                            | Untrusted until the token index resolves an attendee.           |
| Decrypted booking rows                   | Resolve the attendee and every listing they hold.               |
| Row `refunded`, `checked_in`, `quantity` | Decide the scan result per row.                                 |
| `listing.non_transferable`               | Requires ID confirmation before a live row is admitted.         |
| Session role and read-only state         | Existing `SCANNER_JSON` and page guards remain authoritative.   |

Expected facts stay separate from observed facts: the scope is derived from the
group's stored membership and setting, and the attendee's rows are read from the
database at scan time. One is never substituted for the other.

## Valid states

The scanner adds one stored column, `groups.scan_checks_in_all_listings`
(default 0), and one checkbox that writes it. It writes `checked_in = 1` on
existing `listing_attendees` rows and activity-log rows, through the same writes
the listing scanner uses.

### Scope

A scan resolves against a scope: the group's member listings, minus members
marked "No check-in". The one-listing scanner is the same mechanism with a scope
of one listing. Hidden and inactive members stay in the scope, because a hidden
member can carry genuine guest-list tickets.

### Scan decision

One mechanism resolves every scan, listing or group. The attendee's rows group
by listing, in the booking order the token reader already returns. "Live" means
not refunded and quantity above zero.

| Case                                                              | Required result                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No row in scope, no `force`                                       | `wrong_listing` with the attendee's listing names                                  |
| No row anywhere on the token, `force` or not                      | 404 `not_found`, or `wrong_listing` with "Unknown listing" when unforced           |
| Rows in scope, none live                                          | `refunded`                                                                         |
| Live rows in scope, none unchecked                                | `already_checked_in`                                                               |
| Preference off (default): one listing at a time                   | Check in the first listing that has an unchecked live row, and name it             |
| Preference on: check in every listing                             | Check in every listing with an unchecked live row                                  |
| A listing to be admitted is non-transferable, `id_verified` unset | `verify_id`; no row is written                                                     |
| No row in scope, `force`                                          | Walk rule over all the attendee's listings: admit the first unchecked live listing |

A repeat scan under the default walks to the next listing with an unchecked live
row. That is the owner's "one listing at a time, which is most flexible": a
several-day or several-tier holder is admitted once per scan, and every door
after the first still works. The one write per listing is
`updateCheckedIn(attendee, listing, true)`, which already marks every row the
attendee holds on that listing. A parent row and its folded child row sit on
different listings, so a listing at a time never counts them as one person twice
in a single admission.

The `verify_id` check runs on the listings about to be admitted, after the
refunded and already-checked states, so a non-transferable listing whose row is
already checked in answers `already_checked_in` — the listing scanner's order
today.

### Response shape

The JSON response keeps today's fields, `name`, `quantity`, `status`, and adds
`listingName`, the comma-joined names of the listings that drove the answer,
plus `remaining` on `checked_in`: how many in-scope listings with an unchecked
live row are left after this scan. Camera and manual entry use this one
scope-aware path.

### Manual roster

The group scanner page offers one option per person: name, summed quantity of
their unchecked live places in scope, and their token. A manual check-in behaves
exactly like a camera scan — same walk rule, same setting — so a pick from the
list never admits something the camera must refuse. The client removes a
person's option only when `remaining` reaches zero.

### The checkbox

Groups with more than one in-scope listing show a checkbox under the scanner
window: "Check in every listing in this group when scanning any". It saves
through `POST /admin/groups/:id/scanner` and the page reloads with its stored
state. The same field appears on the group Edit form, and it belongs to the
group's catalog record, so exports, imports, and the admin API carry it.

## Commands and outcomes

| Command                          | Required result                                                     |
| -------------------------------- | ------------------------------------------------------------------- |
| GET `/admin/groups/:id/scanner`  | Render the group scanner page with the roster and checkbox, or 404. |
| GET `/admin/listing/:id/scanner` | Unchanged render, on the shared scope-aware core.                   |
| POST `/admin/groups/:id/scan`    | Resolve the scope and preference, then the scan decision above.     |
| POST `/admin/listing/:id/scan`   | The same decision with a scope of one listing.                      |
| POST `/admin/groups/:id/scanner` | Save the checkbox, then redirect back to the scanner page.          |
| Group page render                | Show a Scanner tab for staff, linking the scanner route.            |

Each admission writes one `UPDATE listing_attendees` per admitted listing in one
batch, then one `logActivities` batch with one row per admitted listing. The
scanner's existing message names each row's own listing.

## Failure table

| Work completed | Failure                  | Required result                                                     | Retry owner                |
| -------------- | ------------------------ | ------------------------------------------------------------------- | -------------------------- |
| Nothing        | Unauthenticated or 403   | Existing `SCANNER_JSON` or form refusal                             | Door staff                 |
| Nothing        | Missing group id         | 404                                                                 | Caller after correction    |
| Nothing        | Missing token field      | 400 `Missing token`                                                 | Caller                     |
| Scope resolved | Token resolves to nobody | 404 `not_found`                                                     | Caller                     |
| Rows read      | Key unavailable          | 500 `Decryption unavailable`                                        | Request infrastructure     |
| Rows read      | A write fails mid-batch  | The batch rolls back. No partial check-in, no activity rows         | Door staff re-scan         |
| Nothing        | Read-only mode           | The scan allowed. The checkbox save blocked like other group writes | An owner with write access |

## Retry and replay

A scan has no idempotency key. Its stable identity is the row it writes. An
exact replay reads the rows again. Under the default it walks to the next
listing, and it answers `already_checked_in` only when nothing remains. With the
preference on it answers `already_checked_in` at once. Two concurrent scans of
the same token both write `checked_in = 1`, an idempotent write. At worst the
activity log names the same person twice, which is the existing listing-scanner
behavior under the same race. Nothing can double-admit, because admission is a
boolean column, not a counter.

## Concurrency

| Operation A   | Operation B                        | Required result                                                                                          | Protection                 |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| Group scan    | Same group scan                    | Both answer a true state. One admission per listing.                                                     | Idempotent column write    |
| Group scan    | Listing scanner or roster check-in | The later request answers for what remains                                                               | Row read before each write |
| Group scan    | Refund of the same row             | A scan that reads first admits. The refund then reverses the money, and the next scan answers `refunded` | Existing refund machinery  |
| Group scan    | Membership edit                    | The scan resolves the scope at request time                                                              | Request-scoped read        |
| Checkbox save | Group edit form save               | Both write the same column. The last write wins, and both surfaces read it back                          | One stored column          |

## Owner choices

Recorded 15 September 2026.

1. **One listing at a time, with a stored group preference for all at once.**
   The default admits one listing per scan, which is the most flexible for
   several-day groups and several-tier bundles. A checkbox under the scanner
   window — shown once the group has more than one in-scope listing — turns on
   "check in every listing in this group when scanning any", stored as the group
   setting `groups.scan_checks_in_all_listings`.
2. **Non-admin door staff are a separate feature.** Dan771's public scanner URL
   is out of scope here: no public exposure ships in this change. The agreed
   direction is a "Scanner" user class that can only check people in and out,
   tracked in its own issue.
3. **Admission membership** excludes only members marked "No check-in". Hidden
   and inactive members stay, because hidden members carry guest-list tickets.
   No date restriction applies.

## Security and privacy

- The scanner page and scan API are staff-only (owner and manager), matching the
  listing scanner's `SCANNER_JSON` default and `requireSessionOr` gate. The gate
  runs before the group is loaded, so an editor or agent meets 403.
- The group page renders the Scanner tab link only for staff, matching the
  route's own gate.
- The scan API stays allow-listed in read-only mode, as the listing scan is. The
  checkbox save is a group write and stays blocked there.
- Manual roster rows decrypt attendee names through the request private key, as
  the listing scanner page does today. No new PII crosses a boundary.
- `POST /admin/groups/:id/scan` joins the JSON API pattern in middleware, so the
  scanner page's `fetch` content-type and unauthenticated JSON refusal behave
  exactly as the listing scan's do.

## Module and test map

| Responsibility               | Source                                                                                                                                              | Tests                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Scope-aware scan decision    | `src/features/admin/scanner.ts`, one core for both route pairs                                                                                      | `test/integration/server/scanner.test.ts`, new `test/integration/server/group-scanner.test.ts` |
| Group roster and checkbox    | `src/features/admin/scanner.ts`                                                                                                                     | The group scanner suite                                                                        |
| Setting column and migration | `src/shared/db/migrations/2026-09-15_*.ts`, `tables-catalog.ts`, `src/shared/catalog-fields/fields.ts`, `src/shared/types.ts`                       | Migration suite picks it up; group form tests                                                  |
| Group form checkbox          | `src/ui/templates/fields/group.ts`                                                                                                                  | Group form field tests                                                                         |
| Scanner client               | `src/ui/client/scanner.js`, `src/ui/client/admin/manual-checkin.ts` read `data-scan-path`; template `src/ui/templates/admin/scanner.tsx` carries it | Template assertions in scanner suites                                                          |
| Group page tab and areas     | `src/features/admin/group-page.ts`, `src/shared/admin-surface/areas.ts`                                                                             | Group page tab tests, `test/integration/admin-role-matrix.test.ts` counts                      |
| Read-only and JSON API       | `src/features/app/read-only.ts`, `src/features/middleware.ts`                                                                                       | Read-only matrix tests                                                                         |
| Copy                         | `src/locales/en/check-in.json`, `groups.json`                                                                                                       | `i18n-coverage` test                                                                           |

### Tests that prove the contract

- Scans for each of three tiers in one group, all through one group scanner.
- An outside-group ticket answers `wrong_listing`, and `force` admits one
  listing.
- A multiple-listing ticket walks one listing per scan under the default, names
  the admitted listing each time, and answers `already_checked_in` at the end.
- The checkbox on: one scan checks in every listing with an unchecked live row,
  and the setting persists across page loads.
- The checkbox appears only for a group with more than one in-scope listing.
- Part-refunded and part-checked-in tickets admit only what remains.
- A "No check-in" member is out of scope: its ticket answers `wrong_listing` at
  the group door, and it never appears on the manual roster.
- Hidden and inactive members stay in scope.
- `verify_id` holds a non-transferable member ticket before any row is written.
- The manual roster dedupes one person to one option and only offers people with
  an unchecked live row, through the scan path itself.
- Editor and agent get 403 before the group lookup. An unknown group 404s.
  Read-only mode still admits the scan but blocks the checkbox save.
- Concurrent identical scans leave one true state.
- The listing scanner responses gain `listingName` and `remaining`, and its door
  stories stay green on the shared core.
- The group door joins the acceptance story: tiers, the outside-group ticket,
  the walking repeat scan, and the group checkbox, through the group scanner
  page.

## Vertical PR

One PR. The core, both route pairs, the client change, the tab, the column and
migration, the checkbox, and the tests land together, because the listing routes
migrate onto the shared core in the same change and no parallel implementation
remains.

The Scanner user class records in its own issue, out of this change.
