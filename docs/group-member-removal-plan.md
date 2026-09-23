# Group member removal plan

Issue #2393. The group page at `/admin/groups/:id` offers a form that adds
member listings. It offers no action that removes one member. An operator must
open the listing edit form and untick the group checkbox there. This plan adds
`POST /admin/groups/:id/remove-listings` and a remove form on the Overview tab.

## Current-system value

The group page removes a member in one action. Today the operator needs the
listing edit form for the same write. The add-listings route
`src/features/admin/groups.ts` and the Overview panel
`src/ui/templates/admin/groups/overview.tsx` receive the change.

## Behavior contract

### Trusted facts

- The URL supplies the group id. `groupFormPost` loads the group row and answers
  404 when no group has that id. The session and the CSRF token are checked
  before the handler runs.
- The form supplies `listing_ids` as checkbox values. The page rendered the
  checkboxes from the group's stored members. A stale form can still name a
  listing that another request deleted or removed.
- The stored membership rows are the truth. The write reads them again inside
  the transaction, so the rendered checkboxes are never trusted as the current
  set.
- The route audience is `CONTENT_ADMIN_LEVELS`. The listing edit form at the
  same level permits the identical membership change. Group deletion stays
  staff-only. Membership removal is reversible.

### Valid states

No new state machine. A group holds zero or more membership rows. The command
deletes the `(listing, group)` rows that the caller names. Group membership is
many-to-many, so a listing that sits in several groups keeps every other
membership row.

### Commands and events

| Starting state                                     | Command or event         | Required result                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Listing `L` is a member of group `G`               | `RemoveListings(G, [L])` | The membership row is gone. The `listing_prices` rows keyed to `G` for `L` are gone. Other memberships and their overrides stay. Redirect to the Overview tab with a success flash and an activity log line. |
| `L` is not a member of `G` (stale form)            | `RemoveListings(G, [L])` | No write for `L`. No error. Same success redirect.                                                                                                                                                           |
| `L` was deleted before the post                    | `RemoveListings(G, [L])` | No write for `L`. No error. Same success redirect. The transaction validator reports a missing listing and skips it.                                                                                         |
| `G` was deleted before the post                    | `RemoveListings(G, [L])` | No write. Redirect to the groups list with `error.selected_group_deleted`.                                                                                                                                   |
| The selection is empty                             | `RemoveListings(G, [])`  | No write. Same success redirect. Mirrors add-listings.                                                                                                                                                       |
| Read-only editor posts the form                    | `RemoveListings(...)`    | The route audience rejects the request. The form is not rendered for a read-only viewer.                                                                                                                     |
| The transaction validator rejects a membership set | `RemoveListings(...)`    | The whole batch rolls back. The validator message shows as the flash.                                                                                                                                        |

One authoritative production implementation: `removeListingsFromGroup` in
`src/shared/db/groups/membership/package-writes.ts`, the mirror of
`assignListingsToGroup`.

### Failure table

| Work completed    | Failure                                             | Required result                                                                                                               | Retry owner       |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Nothing           | The group row is missing                            | No write. Redirect to the groups list.                                                                                        | Operator          |
| Nothing           | The write lock stays busy or an upstream read fails | The transaction rolls back. The client retry raises `DatabaseBusyError` or the upstream error. The response is an error page. | Operator re-posts |
| Part of the batch | A statement fails                                   | The transaction rolls back. No partial removal.                                                                               | Operator re-posts |

There is no external provider call. The command is one local transaction.

### Retry and replay table

- The command is idempotent by membership row. An exact replay deletes rows that
  no longer exist. SQLite treats that as a no-op.
- The operator retries after an interruption by re-posting. The form re-renders
  from live state, so a retry shows the current members.
- No scheduled worker or callback takes part.
- A failed request cannot block a later request. Each post opens its own
  transaction.

### Concurrency table

| Operation A               | Operation B                                       | Required result                                                                                                                                                     | Protection                            |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Remove `L` from `G`       | Add `L` to `G` (add-listings form)                | One membership row ends the race with a member; the remove-first order ends with no member. Each transaction reads the current set inside its own write lock.       | Transaction lock                      |
| Remove `L` from `G`       | Save the listing edit form (`setListingGroupsTx`) | The same serialization. Both paths run the diff statements from `listingGroupDiffStatements`.                                                                       | Transaction lock                      |
| Remove `L` from `G`       | Delete group `G`                                  | Either the remove sees a live group and commits, or it sees no group and reports the deletion. `resetGroupListings` in the delete path removes every member anyway. | Transaction lock and fresh group read |
| Remove package member `L` | A checkout of the package at commit time          | The webhook revalidation prices from live membership after the commit and refuses the stale checkout. This is the current behavior of the listing edit form path.   | Webhook revalidation                  |

### Owner choices

None on data. Removal is reversible. Bookings and money stay on the listing. The
per-group price and quantity overrides are deleted on purpose. An operator who
re-adds the listing enters those values again. The form copy states all of this.
The issue asks for the same write, not a new decision.

### Security and privacy

- Who can perform the action: `CONTENT_ADMIN_LEVELS`, the same audience as the
  group edit route. The route table in `src/shared/admin-surface/areas.ts`
  declares it.
- Links each role sees: the remove form renders only for a write-capable viewer.
  `isReadOnly()` already gates the add form on the same surface.
- No secret or personal field crosses a boundary. The write deletes membership
  and price rows.
- Untrusted input: `listing_ids` values are parsed as positive numbers, and the
  transaction reads fresh listing state before any statement runs.

## Shared contract

`removeListingsFromGroup(listingIds: number[], groupId: number): Promise<string | null>`

- Mirrors `assignListingsToGroup`. One `withTransaction`.
- A fresh `groupStatesTx` read answers `error.selected_group_deleted`.
- For each listing, read the current group set, drop `groupId`, and run
  `setListingGroupsTx` with the remaining set. `setListingGroupsTx` already
  validates the membership, skips a deleted listing, and builds the same diff
  statements the listing edit form uses. No parallel statement builder.
- Returns an error message for the flash redirect, or null on success.

The route handler parses `listing_ids`, calls the one implementation, logs the
activity line, and redirects. The Overview panel renders a second
`LinkedItemsCheckboxes` form from the member listings it already loads. The add
form and the remove form share `SaveForm`, `toLinkedItemOptions`, and the
catalog copy for the submit label.

## Self-challenge

- **What if the group disappears between the page load and the post?** The fresh
  group read inside the transaction answers the deletion. The operator lands on
  the groups list.
- **What if a listing disappears?** `setListingGroupsTx` reports a missing
  listing and skips it. No partial write, no error.
- **What if the operator re-posts after an interruption?** The second run is a
  no-op on the removed rows. The success flash is correct either way.
- **What does a buyer see mid-change?** A live checkout prices from live
  membership. The webhook revalidation refuses a checkout whose package member
  list changed. That is the current listing-edit behavior.
- **What happens to sold tickets that carry `package_group_id`?** Those rows
  keep their stamp. The package display still resolves through the live group
  row, because the group still exists. New checkouts exclude the removed member.
  This matches the listing edit form path today.
- **Can removal break the package invariant?** No. All package member rules
  judge joiners and group flags. A group with zero members is valid.
- **Can one failed listing block the batch?** Yes, by design. One transaction
  commits or rolls back as one unit. A single listing failure rolls the whole
  batch back.

## Pull request slice

One pull request.

| File                                                | Change                                                    | Lines (about) |
| --------------------------------------------------- | --------------------------------------------------------- | ------------- |
| `src/shared/admin-surface/areas.ts`                 | The `groupRemoveListings` write pattern                   | 1             |
| `src/shared/db/groups/membership/package-writes.ts` | `removeListingsFromGroup`                                 | 30            |
| `src/features/admin/group-listing-forms.ts`         | The two membership posts, split out of `groups.ts`        | 110           |
| `src/features/admin/group-form-post.ts`             | The `groupFormPost` factory, split out of `groups.ts`     | 25            |
| `src/ui/templates/admin/groups/overview.tsx`        | The remove form                                           | 30            |
| `src/locales/en/*.json`                             | Submit label, remove heading, warning copy, success flash | 6             |

The plan first left `src/shared/admin-surface/areas.ts` out, because the
add-listings route declares no entry of its own. The role-matrix tests answered
that: an undeclared write takes its roles from the handler alone, and the
declared-writing gap is counted so that it cannot widen. So the built code
declares `groupRemoveListings`, and the add-listings route stays as a counted
gap.

Source budget: about 100 to 120 lines. Test files and the issue close sit
outside this count.

### Tests

- Unit tests for `removeListingsFromGroup`: the membership row and this group's
  price overrides are gone. Other groups' memberships and overrides stay. A
  non-member is a no-op. A deleted group returns the error message. A deleted
  listing is skipped.
- Route tests for `POST /admin/groups/:id/remove-listings`: the write lands and
  the flash shows. A read-only editor is refused. The removed listing appears in
  the add form again. A member of two groups keeps the other membership.
- Regression test from the issue: a package member with a per-package `quantity`
  loses that override on purpose.

## Decisions

1. The remove control is the multi-select form. It matches the add-listings form
   and reuses its components. A per-row button needs a row action pattern that
   the member table does not carry today.
2. A Cucumber story for the operator journey ships with the direct tests. It
   extends `specs/catalogue/` beside the group features.
