# Plan: Explain restriction refusals, and give a status in use a way out

Closes #2275, #2276, and #2277. One pull request, one theme: an admin save that
must be refused names its rule at (or before) the refusal, and a conflict the
operator can resolve offers the move that resolves it.

## Current-system value

Today an operator learns of a broken restriction only when a save is refused,
and three refusals dead-end or under-inform:

- A package whose member quantity ("Qty per package") passes the member's own
  per-order cap ("Max tickets per purchase") saves without warning and then
  sells nothing (`capacity-tree.ts` floors the cap to 0). The operator learns
  when a visitor reports the gallery as sold out.
- A status that attendees hold cannot be deleted, with no way out. The operator
  must hand the attendees to another status through the attendee forms, one by
  one.
- Several refusals name no clash: a group picker offers a listing the group must
  refuse, a duration clash names only the child, and a role refusal answers with
  the bare text "Forbidden".

One PR closes all three. The write paths are the group edit POST (and the admin
groups JSON API, and the catalog import), the listing save POST (and the listing
JSON API), the group add-listings POST, the listing and status settings forms,
the status delete flow, and the admin page guard.

Facts this plan checked before writing:

- #2276's first bullet (a hint beside the answer modifier selector) already
  ships. `questions.edit_answer.modifier_hint` landed in PR #1310 and reads
  "Applies an \"answer\"-triggered modifier whenever a buyer picks this answer.
  Create one on the Modifiers page first." This PR pins it with a template test
  and notes the item in the PR description.
- #2276's fifth bullet names two halves. The nav half already ships:
  `navEntryVisible` in `#shared/admin-pages.ts` filters every nav link by the
  route's declared audience, and `test/integration/server/editor.test.ts` ("nav
  shows only the editor's reachable sections") pins it. This PR gives the 403
  body its copy.

## How the repo already applies this pattern

The mechanism this PR extends is the declared reason list
(`#shared/reasons.ts`): one list per domain, read by every consumer. Four lists
exist today - `EDGE_ERROR_RULES` (listing parent/child edges),
`groupHomogeneityError` (group membership), `CART_CONFLICT_REASONS` (cart
conflicts), and `PACKAGE_MEMBER_BLOCKS` (package membership, shared by the group
save, the listing form, the catalog importer, and the transaction-local recheck
in `packageMembersErrorTx`).

The second mechanism is the `TransactionValidationError` boundary: a local guard
inside a write transaction throws it, and `#shared/rest/resource.ts` turns the
message into the form's flash error or the JSON API error body. The
transaction-local fence and the operator-facing refusal are therefore one call,
not two.

This PR adds its rules inside these mechanisms. It does not invent a second
pattern. Every rule below is one new reason in an existing list, or one new
reader of an existing list. The message key is the error code, so no registry is
needed.

## Behavior contract

### 1. #2275 - a package member's own cap stays at or above its pick count

Trusted facts:

| Fact                                                     | Status   | Basis                                              |
| -------------------------------------------------------- | -------- | -------------------------------------------------- |
| `listing.max_quantity` (the per-order cap)               | Trusted  | Positive-int column, min 1 at the listing boundary |
| `group_listings.quantity` (the pick count)               | Trusted  | Positive-int column, min 1 at every writer         |
| `maxPurchasable <= max_quantity`                         | Observed | `booking/model.ts` clamp                           |
| Bundle limit = floor(min(cap, child limit) / pick count) | Observed | `capacity-tree.ts` `ownLimit`                      |

Valid states:

- For every member of a package: `quantity <= max_quantity`. The save refuses
  any write that creates the other state. No runtime fallback exists.

Commands and events:

| Starting state | Command                                                     | Required result                                            |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Valid package  | Group write sets a member's quantity above the member's cap | Refuse. Message names the member. No row changes.          |
| Valid package  | Listing write sets max_quantity below a membership quantity | Refuse. Message names the member. No row changes.          |
| Valid package  | Catalog import writes such a pair                           | Refuse. The importer reports the message. Nothing imports. |
| Valid package  | Add-listings POST (new members get quantity 1)              | Never violates the rule. No new check needed.              |

Failure table:

| Work completed | Failure                                                         | Required result                                  | Retry owner       |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------ | ----------------- |
| Nothing        | Local write finishes, member row changed between load and write | Transaction-local recheck refuses and rolls back | Operator re-saves |
| Nothing        | Two saves race (one lowers a cap, one raises a quantity)        | The later write refuses, the invariant holds     | Operator re-saves |

Retry and replay: form saves carry no queue. A re-submit re-validates and
returns the same refusal until the operator fixes the numbers.

Concurrency:

| Operation A                     | Operation B                     | Required result       | Protection                                            |
| ------------------------------- | ------------------------------- | --------------------- | ----------------------------------------------------- |
| Listing lowers its max_quantity | Group edit raises the quantity  | Later write refuses   | Transaction-local recheck over transaction-fresh rows |
| Group edit raises quantity      | Concurrent identical group edit | One wins, one refuses | Write lock, retry on SQLITE_BUSY                      |

Owner choices: none. The arithmetic decides; the save must refuse.

Security and privacy: group edit and listing save keep their current audiences.
The message can name the member listing's name, because those pages already
decrypt names for that same surface. No new route.

Shared contract: one pure rule in `#shared/package-membership.ts` with catalog
key `error.package_member_cap`. `packageMemberCapExceeded` is the one home of
the arithmetic (and of the omitted-count-lifts-to-one rule);
`packageMemberCapError` builds the message, and rows carry the optional quantity
end to end. The built thing differs from this contract in one deliberate way:
`PackageMemberInput.quantity` stayed optional on the type, and the pre-existing
`memberQuantityStatement` default (`quantity ?? 1`) remains the single
write-boundary lift; every parser still defaults to one before the write sees
the value.

Two fences wire it in, both in `src/shared/db/groups/membership.ts`:

- Group writes (`writePackageMembersTx` covers the group edit POST and the
  groups JSON API) judge the submitted quantities through
  `submittedMembersCapErrorTx` against `listingStatesTx`'s `max_quantity` before
  any member row changes. Only members the write keeps are judged, so a stale or
  crafted id follows the existing `validMembers` drop instead of a refusal.
- Listing saves and both catalog import paths (`import.ts` and
  `import-listing.ts`) reach `oneMembershipErrorTx` through
  `validateListingGroupMembershipTx`/`validateListingGroupMembershipsTx`. It
  judges the stored quantity (the members list now carries it via
  `groupStatesTx`'s `COALESCE(groupListing.quantity, 1)`) against the listing's
  `max_quantity` through `memberCapErrorTx` (`ownQuantity`), which decrypts the
  name only for a member that fails.

Tests: table-driven unit rows for the pure rule; integration rows that POST the
group edit and the listing edit and assert the flash message and the unchanged
rows; an importer row.

### 2. #2277 - reassign, then delete, a status in use

Trusted facts:

| Fact                                     | Status  | Basis                                             |
| ---------------------------------------- | ------- | ------------------------------------------------- |
| Count of attendees with `status_id = id` | Trusted | One SQL count, read inside the delete transaction |
| The other statuses                       | Trusted | Cached list table, owner session                  |

Valid states: a status is either free (zero attendees) or in use (N > 0). Delete
has one command with an optional target. The page shows the target picker when
the status is in use.

Commands and events:

| Starting state    | Command                                                     | Required result                                                                                          |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Free status       | Delete POST                                                 | Row deleted, as today.                                                                                   |
| In-use status (N) | Delete GET                                                  | Page shows the count and a required picker of other statuses.                                            |
| In-use status (N) | Delete POST with a target                                   | One transaction moves all N attendees to the target, then deletes the status. Activity log records both. |
| In-use status (N) | Delete POST with no target                                  | Refuse. Message states the count.                                                                        |
| In-use status (N) | Delete POST with a target that vanished after the page load | Refuse. Message asks the operator to pick again.                                                         |

Failure table:

| Work completed | Failure                             | Required result                     | Retry owner      |
| -------------- | ----------------------------------- | ----------------------------------- | ---------------- |
| Nothing        | The reassign UPDATE fails           | Roll back both writes. Error flash. | Operator retries |
| Nothing        | The delete fails after the reassign | Roll back both writes.              | Operator retries |

Retry and replay: a second POST after success reads no row (the load short
circuits) and answers not-found, as today's deletes do.

Concurrency:

| Operation A          | Operation B                                   | Required result                        | Protection                                                    |
| -------------------- | --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| Reassign plus delete | Checkout inserts an attendee with this status | The new attendee moves with the others | The same write lock; the count is read inside the transaction |

Owner choice: the target status. The save fails closed until the operator picks
one. The page warns in one line that the move changes each attendee's status and
that a reservation amount does not travel with them.

Security and privacy: the flow stays owner-only (`settingsStatuses` audience is
unchanged). The activity log names the statuses; that surface already shows
decrypted names to the owner.

Shared contract: `attendeeStatusWrites.delete(id, reassignTo?)` in
`src/shared/db/attendee-statuses.ts` — one command, one authoritative
implementation. The internals are `reassignHeldAttendees` (count probe, then the
move) and `reassignNameRows` (one query returning both statuses' names for the
activity log, written with `logActivity(…, tx)` inside the transaction). A
missing, `undefined`, or self target surfaces as `status_in_use`. The route side
(`src/features/admin/settings-statuses.ts`) reads the target from the form
(`statusOperations.delete` gets `form.getOptionalInt("reassign_status_id")`) and
overlays a bespoke delete GET (`statusDeleteGet`) that renders
`retireStatusDeletePage` from `src/ui/templates/admin/settings-statuses.tsx`,
sharing `DELETE_PAGE_LABELS` with the generated page.

Tests: integration rows for each command row above; a fault test
(`test/test-utils/db-fault.ts`) that fails the reassign UPDATE and asserts both
writes rolled back; a template test for the count and the required picker.

### 3. #2276 - say why before the save, four remaining surfaces

Item 2 - grey out the listings the group must refuse (overview picker):

| Starting state                 | Command           | Required result                                                                                                             |
| ------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Group with members of one type | GET group page    | A candidate whose type or customisable-days setting clashes renders a disabled checkbox with the refusal message beneath it |
| Same                           | Add-listings POST | The save side stays the authority; no new check. Disabled inputs are not submitted                                          |

Trusted facts: the candidates and the sibling settings, both already loaded for
this page. The reason reader is `groupCandidateBlockedError`
(`src/shared/db/groups/homogeneity.ts`), a picker-fold over the same two
homogeneity rules the saves consult, so the picker and the save cannot drift. It
speaks as the candidate ("this listing can't join, because its settings differ
this way") rather than as the save, which is why it is a sibling of
`groupListingSettingsError` and not a reuse of its save-side wording.
`LinkedItemOption` carries the optional refusal (`blocked`); the disable + why
rendering lives once in `linked-items.tsx`, and `GroupOverviewPanel` maps each
ungrouped candidate through the same rule.

Item 3 - one pair of controls per form disables its counterpart, with a one-line
why:

| Form         | Pair                                             | Required result                                                                                                  |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Listing edit | Customisable days vs Allow customers to pay more | Checking one disables the other and shows the existing refusal copy (`error.customisable_days_with_pay_more`)    |
| Status form  | Paid default vs Reservation                      | Checking one disables the other and shows the refusal copy; the current hard-coded string moves into the catalog |

The server-side refusals stay: the client affordance is a hint, not the
authority. The pair is declared once, as data: the form fields carry
`data-exclusive-with`/`data-exclusive-why` through the new optional `dataAttrs`
on `FieldBase` (`src/shared/forms/field.ts`, rendered by `renderCheckboxGroup`),
the settings-page pair carries the same two facts as `SettingsCheckbox`'s
`exclusive` option, and one client module
(`src/ui/client/admin/paired-controls.ts`, wired from `src/ui/client/admin.ts`)
disables the counterpart and toggles the why. A future pair needs no new script.

Item 4 - name the clash in the duration refusal. The `EDGE_ERROR_RULES` entry
for `children_err_child_duration` builds its message inline from the pairing's
facts (the `#shared/reasons.ts` pattern for a message that needs the evidence
found): the parent's offered lengths and the child's priced length. The rule's
precedence slot and its identity stay.

Item 5 - a role refusal says who can open the page. The HTML 403 body replaces
the bare text "Forbidden".

| Refused route's audience | Body                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| Exactly owner-only       | "Only the owner account can open this page." plus one line on what to do |
| Any other audience       | "Your account can't open this page. Ask the site owner for help."        |

The copy must not name the route or leak its existence beyond what the 403
already says. The guard knows the audience, so it computes the fact with
`ownerOnlyAudience` and passes it into the failure builder:
`authFailure(channel, reason, forbiddenDetail?)` in `src/features/auth.ts` takes
the optional `"owner-only"` detail and picks the body; the JSON channel stays
generic.

| Starting state                      | Command     | Required result                 |
| ----------------------------------- | ----------- | ------------------------------- |
| Editor opens an owner-only page URL | GET         | 403 with the owner-account body |
| Staff opens an editor-only page URL | GET         | 403 with the generic body       |
| Any refused JSON API call           | GET or POST | 403 JSON body unchanged         |

Tests: a template test per surface (picker, two forms, questions hint pinning
test for the shipped item), unit rows for the duration message, and integration
rows for the 403 bodies.

## Adversarial review (self-challenge)

- _What if the external call succeeds and the local write fails?_ No external
  calls here; both writes sit inside one transaction and roll back together.
- _What if the callback is replayed?_ No callbacks. The forms re-submit through
  the same validation.
- _What if the amount, currency, parent, or resource id is wrong?_ Reassign
  validates the target row inside the transaction; membership writes ignore
  stale or crafted member ids (existing `validMembers` rule, unchanged).
- _What if two requests run together?_ Both new fences read transaction-fresh
  rows inside the write lock; the last write refuses.
- _What if the user reloads after an interruption?_ Nothing durable changed
  until the save commits; the form re-renders with the refusal.
- _What if one queued item fails permanently?_ No queue.
- _What does the buyer or operator see in every unfinished state?_ The buyer
  sees no change in any of these paths. The operator sees the refusal message,
  or the reassign page.
- _Does the picker's disabled state agree with the save?_ The picker reads the
  same reason list the save's transaction rechecks; the test pins one candidate
  through both.

## Pull request slices and budget

One vertical PR, branch `restriction-refusals` from `origin/main`.

| Slice                                | Contract rows                  | Source budget (est.) |
| ------------------------------------ | ------------------------------ | -------------------- |
| Cap rule + two fences (#2275)        | 3 command rows, 2 failure rows | ~140 lines           |
| Reassign-and-delete (#2277)          | 5 command rows, 2 failure rows | ~170 lines           |
| Picker, pairs, duration, 403 (#2276) | 6 rows                         | ~200 lines           |

Total ~510 source lines, below the 800-line limit. Tests and catalog edits sit
outside the cap. The PR description reports the exact counts.
