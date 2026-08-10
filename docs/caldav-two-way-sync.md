# CalDAV calendar mirror (push) — behavior contract

Status: **draft, awaiting final human approval** (PR_WORKFLOW.md step 6). No
tests or implementation exist yet. Revision 4 is a deliberate **rescope by the
owner** (PR #2064): the sync is now **one-way, site → calendar**. The owner
chose push-only, "ignore inbound changes", "no calendar creates/deletes", and
paste-the-address setup. The earlier two-way contract (three review rounds deep)
is preserved in this file's git history at commit `1be31c4` and indexed in
`TODO.md` for the day the pull direction is wanted.

The design was researched against
[eventschedule](https://github.com/eventschedule/eventschedule)'s CalDAV
implementation; where it copies or departs from theirs, the text says so.

## Current-system value

Operators today can only mirror bookings _out_ through the read-only ICS feed
(`GET /caldav/events.ics` in `src/features/feeds.ts`), which calendar apps poll
on their own slow schedule and which never writes into the operator's real
calendar. This feature makes the operator's own calendar (Nextcloud, Fastmail,
iCloud, Radicale — anything CalDAV) contain every dated listing as a real event
— created, updated, and removed as listings change on the site.

The calendar copy is a **mirror, not a second editor**: the site is the boss.
Anything changed on the mirrored events in the calendar is overwritten by the
next push, and the settings copy says so in plain words.

Production receivers of the change:

- `/admin/settings` (owner section) — connect, verify, disconnect.
- `listingsTable` in `src/shared/db/listings/records.ts` and **every other
  listing-creation surface** (the statement-based catalog-transfer import in
  `src/features/admin/catalog-transfer/import-listing.ts` and bulk cloning in
  `src/features/admin/bulk-actions.ts`) — every listing write marks the row for
  push.
- Domain settings (`src/features/admin/settings-domains.ts`) — custom-domain and
  host-domain changes bump every dated listing, because pushed events embed the
  listing link and must repush with working URLs.
- The scheduled maintenance runner (`POST /scheduled`,
  `src/shared/maintenance/registry.ts`) — one new task, `caldav_push`, does all
  external calendar IO.

## Scope

- This system is a CalDAV **client** that writes to one operator-pasted calendar
  collection. We do not implement a CalDAV server, and we never read calendar
  contents (no REPORT, no pull, no conflict rules).
- Only **dated listings** mirror. Bookings/attendees remain feed-only.
- Connected means mirroring; there is no separate direction or pause setting.
  Stopping is disconnecting.
- No foreground request makes a CalDAV call except the connect-time verification
  (a PROPFIND plus a write probe, below). All mirroring IO happens inside one
  scheduled task, a bounded batch per wake. Steady-state edit volume converges
  in one wake (15 minutes on the default monitor cadence); a large backlog —
  first connect on a site with many dated listings — takes several wakes, and
  the sync status says so.

## Trusted facts

| Fact                                             | Why it may be trusted                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar URL, username, app password             | Operator-pasted, verified before saving by a live authenticated PROPFIND that must identify a **calendar collection**, then a probe event PUT and DELETE proving **write access**. A read-only calendar, a principal URL, or a plain WebDAV folder fails the test and is never stored. Stored as encrypted settings. Expected facts, not proof of later success.                                            |
| The UID namespace                                | A random token minted when a calendar URL is first saved (or changed) and stored in settings. Immutable while that destination is in use, so pushed identities survive custom-domain changes and disconnect/reconnect to the same calendar. Doubles as the connection **generation**: every task state write requires the generation it started with.                                                       |
| Pushed event identity `listing-{id}@{namespace}` | Deterministic — derived from the listing id and the stored namespace. Never guessed; the href we PUT to is the one we derived. The only URLs this feature ever requests live under the pasted calendar URL — no server-provided href is ever followed.                                                                                                                                                      |
| A listing row and its `caldav_pending` rev       | Written transactionally by the listing write surfaces; the pending counter is authoritative for "local changes not yet pushed". New rows **start at pending = 1 at the column level**, so statement-based creation paths (catalog import, bulk clone) are covered without per-surface wiring; dateless never-pushed rows are cleared locally by the first wake (vacuous rule below), never sent as deletes. |
| `caldav_pushed_at`                               | Our own record that a create/update PUT succeeded at some point — the fact that a remote copy is expected to exist. Never proves the operator hasn't deleted it by hand (a later push simply recreates it; that is mirror semantics, not an error).                                                                                                                                                         |
| An HTTP 2xx on PUT                               | Proves the server accepted **that** write.                                                                                                                                                                                                                                                                                                                                                                  |
| An HTTP 404 on DELETE                            | Proves the resource is already gone — success for our purposes.                                                                                                                                                                                                                                                                                                                                             |

## Valid states

Site-level connection state (settings-backed):

```typescript
type CalDavConnection =
  | { kind: "disconnected" } // may retain dormant identity state, see below
  | {
    kind: "connected";
    // Credentials verified by a live test at save time.
    calendarUrl: string;
    // Minted when this calendar was first chosen; the generation guard.
    uidNamespace: string;
  };
```

Per-listing sync state, from two columns:

| State          | Facts required                  | Meaning                                                         |
| -------------- | ------------------------------- | --------------------------------------------------------------- |
| `unsynced`     | pending = 0, pushed_at null     | No remote copy expected (never pushed, or listing has no date). |
| `pending_push` | pending > 0                     | Local changes not yet on the calendar.                          |
| `pushed`       | pending = 0, pushed_at non-null | Mirrored; the calendar holds what we last sent.                 |

The pending counter is a **revision**, not a flag: every listing write bumps it,
and every push-side clear is conditional on the value the task read, so a
concurrent edit always survives and repushes.

## Commands and events

| Starting state                               | Command or event                                                                     | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any                                          | Any connect / change / disconnect save                                               | Runs while holding the push task's claim, released when the transition commits. If a push pass is mid-flight, the save fails closed with "A sync is running. Please try again in a minute." — so no leased worker can fire an external call at a destination the owner has just changed away from. The final write also requires the CalDAV settings revision the form rendered with — a stale save fails closed with "settings changed, reload".                                                                                                                                                                                                                                                  |
| disconnected                                 | Owner saves settings (live test passes)                                              | connected. Same calendar URL as before → the dormant namespace, pushed_at stamps, and delete queue are reused, so nothing is duplicated, and pending is bumped on every listing that is dated **or still carries a pushed_at stamp** — a stamped-but-dateless row (its date was removed, then the owner disconnected before the push ran) gets its owed delete queued by the task instead of being orphaned. A different (or first) URL → stamps, queue, and status cleared, a new namespace minted, atomically; every dated listing gets pending bumped.                                                                                                                                          |
| disconnected                                 | Owner saves settings (live test fails)                                               | Nothing stored; the error is shown. No partial credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| connected                                    | Owner changes the calendar URL                                                       | The same atomic transition as connect-with-different-URL: pushed_at stamps **and queued delete jobs** cleared (a queued href must never be fired at a different destination), new namespace minted, pending bumped on all dated listings, **and the durable sync status reset to "not yet synced"** — the settings page never shows one destination's results against another. Events on the old calendar stay there (documented).                                                                                                                                                                                                                                                                 |
| connected                                    | Site domain changes (custom domain added, activated, or removed; host domain change) | Every dated listing gets pending bumped in the same transaction. Pushed events embed the listing link, so they repush with working URLs instead of keeping dead ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| connected                                    | Owner disconnects                                                                    | Credentials and the durable sync status cleared; pending counters zeroed (nothing would consume them; the reconnect bump above restores every one that matters). Namespace, pushed_at stamps, and the delete queue stay **dormant** so reconnecting to the same calendar duplicates nothing and still-owed deletions are not forgotten. Remote events stay on the calendar (documented).                                                                                                                                                                                                                                                                                                           |
| any                                          | Listing created (any surface, incl. statement)                                       | Row starts at `caldav_pending = 1` via the column default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| any                                          | Listing updated                                                                      | `caldav_pending = caldav_pending + 1` in the same statement. No external call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| any                                          | Listing deleted                                                                      | If `caldav_pushed_at` is non-null — a remote copy exists — a `caldav_deletes` queue row (derived href + the deleted listing's id) is written in the same batch as the delete, **whether or not currently connected** (a deletion while disconnected must not orphan the event on a later reconnect). A never-pushed listing queues nothing — the one race that leaves (deleted just as its **first** PUT lands, before the stamp exists) is closed by the task's zero-row finalize rule below.                                                                                                                                                                                                     |
| connected                                    | `caldav_push` wake                                                                   | One claimed task. It reads the generation (namespace) at start; **every state write is conditional on that generation still being stored**, so a settings change mid-pass turns the leased worker's writes into no-ops. Order inside the pass: **drain the delete queue first, then push pending listings** — so a delete-then-recreate on the same listing converges within the wake instead of ending deleted. A post-PUT finalize write that matches zero rows tells "listing deleted" apart from "listing edited": deleted → the task inserts the delete-queue row itself (generation-guarded), so the just-created event is removed on the next drain; edited → the row simply stays pending. |
| push: delete queue row                       | —                                                                                    | If the row names a listing that still exists and is dated again (its date was removed and then restored), drop the row without calling the server — the push step will re-send it. Otherwise DELETE the href; 404 counts as success; remove the row.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| push: pending dated listing                  | —                                                                                    | Build the VEVENT from the listing (same fields as the public feed: name, date, description, location; no DTEND, exactly like the feed). The ticket URL is included **only when the listing passes the same public-visibility gate the `/ticket` page and the feed enforce** — a mirrored-but-unbookable listing's event carries no link rather than a dead one (the shared predicate, not a copy). PUT it to the derived href — a **plain overwriting PUT by design**: the calendar copy is a mirror, so operator edits to it (including an added RRULE or alarm) are replaced, as the settings copy warns. Then set pushed_at and clear pending, guarded by `WHERE caldav_pending = readValue`.   |
| push: pending dateless listing, once pushed  | —                                                                                    | Queue a delete, null pushed_at, **and clear pending**, in one transition guarded by `WHERE caldav_pending = readValue AND date = ''` — the queue row now owns the work, so the row cannot re-plan the same delete every wake. A date restored mid-task survives the guard, stays pending, and repushes; a date restored after the queue insert is caught by the drain-time recheck above.                                                                                                                                                                                                                                                                                                          |
| push: pending dateless listing, never pushed | —                                                                                    | Nothing remote exists, so nothing remote is called: pending is cleared locally, all such rows in **one generation-guarded batch statement** per wake. This is what makes the default-1 column and its migration backfill free — a site full of undated drafts converges on the first wake without spending a single external call on guaranteed 404s.                                                                                                                                                                                                                                                                                                                                              |
| push: more work than the wake's budget       | —                                                                                    | `requestFollowUp()`; the sync status shows the remaining backlog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Every command has one authoritative implementation: a pure planner
(`push-plan.ts`) decides; thin IO applies.

## Failure table

| Work completed          | Failure                         | Required result                                                                                                                                                                                                                                                                                                                                | Retry owner        |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Nothing                 | Save-settings live test fails   | No settings stored; operator sees the error.                                                                                                                                                                                                                                                                                                   | Operator           |
| Listing write committed | (no external work in-request)   | Pending counter is durable; calendar catches up on a later wake.                                                                                                                                                                                                                                                                               | `caldav_push` task |
| PUT succeeded           | Pending-clear write fails       | Task fails; next wake re-runs the same derived-identity PUT — an idempotent overwrite of our own content, never a duplicate.                                                                                                                                                                                                                   | `caldav_push` task |
| Some PUTs done          | A later PUT fails               | Completed rows stay cleared; the failed row stays pending; task reports failure, retries at `failureRetryIntervalMs`. One bad row never blocks the rest.                                                                                                                                                                                       | `caldav_push` task |
| DELETE sent             | 404                             | Success; queue row removed.                                                                                                                                                                                                                                                                                                                    | —                  |
| Mid-pass                | Owner submits a settings change | The save fails closed ("A sync is running. Please try again in a minute.") — settings transitions require the task's claim, so no external call can follow a committed change. The generation guard stays as the fence for a worker that somehow outlives its claim TTL; the wake's bounded budget keeps every pass far shorter than that TTL. | Operator (retry)   |
| Anything                | 401/403 (credentials revoked)   | Task failure every wake; the durable sync status records it so the settings page shows it.                                                                                                                                                                                                                                                     | Operator           |

Every task pass ends by writing a **durable sync status** (a settings key:
timestamp, ok/failed, sanitized bounded error summary, and counts — pushed,
deleted, remaining backlog). The write is inside the task's database budget and
generation-guarded; without it a scheduled-request failure would be invisible to
the operator, who only ever sees the settings page. Sanitized means codes and
counts — never raw server responses. Connect and URL-change reset this status to
"not yet synced", and disconnect clears it, in their own transaction — a fresh
connection never wears the previous destination's success, error, or backlog.

## Retry and replay table

| Question                         | Answer                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Stable identity                  | `listing-{id}@{namespace}` and its derived href.                                                                             |
| Exact replay returns             | Same-bytes PUT to the same href overwrites in place; DELETE replays 404 into success.                                        |
| Who retries after interruption   | The next scheduled wake — pending rows and queue rows persist.                                                               |
| What stops two workers           | The maintenance claim (`claimNextMaintenanceTask`); generation guards stop a stale leased worker crossing a settings change. |
| Permanent failures               | A PUT the server always rejects: row stays pending, surfaced in sync status, blocks nothing else.                            |
| Can one failed item block others | No — per-item isolation; the task still reports failure so retry happens.                                                    |

## Concurrency table

| Operation A                         | Operation B                     | Required result                                                                                                       | Protection                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push PUTs listing content           | Operator edits the same listing | The newer edit is pushed on a later wake, never lost.                                                                 | Pending is a revision counter; every push-side clear runs `WHERE caldav_pending = readValue`, so a bump after the read survives.                                                                                                        |
| Date-removal queues a remote delete | Operator restores the date      | No stale delete; the listing repushes.                                                                                | The queue insert is guarded (`… AND date = ''`), **and** the drain rechecks the listing at execution time, dropping the row if it is dated again. Queue drains before pushes, so even a fired delete is recreated within the same wake. |
| Two scheduled wakes overlap         | —                               | One runner.                                                                                                           | Maintenance claim rows.                                                                                                                                                                                                                 |
| Owner changes settings mid-pass     | A leased push pass is running   | The save fails closed and is retried after the pass — no external call is ever made for a destination the owner left. | Settings transitions run under the push task's claim; every task state write is additionally generation-guarded, fencing a worker that outlived its claim.                                                                              |
| Task sends a listing's first PUT    | Listing deleted concurrently    | The just-created event is still removed.                                                                              | The deletion saw pushed_at null and queued nothing; the task's finalize write matches zero rows, distinguishes deleted from edited, and inserts the delete-queue row itself, generation-guarded.                                        |
| Two owners save CalDAV settings     | —                               | The later-rendered form wins; the stale one fails closed.                                                             | The save carries the CalDAV settings revision it rendered with; the final write requires it to still match.                                                                                                                             |

## Owner choices

**None remain.** The two-way draft's choices (calendar-created events, calendar
deletions, review holds) were removed together with the pull direction, at the
owner's decision on PR #2064. The one behavior an operator must know is
documented, not chosen: **edits made to the mirrored events in the calendar are
overwritten by the next push** — the settings copy states this before
connecting, in plain words.

## Security and privacy

- **Who**: the CalDAV settings section is `owner`-only, and no link to it is
  rendered for other roles. No other role has any CalDAV surface.
- **Secrets**: calendar URL, username, and app password are stored via
  `encryptedUpdate` settings (the Stripe-key pattern). The password field is
  write-only in the UI — never echoed back. Test-connection uses the submitted
  values, not stored ones.
- **Outbound guard**: HTTPS only; redirects never followed; the host must be a
  name, not an IP literal or localhost. The only URLs ever requested are the
  pasted calendar URL and paths derived beneath it — this feature never follows
  a server-provided href, so credentials cannot be steered anywhere the operator
  didn't paste. Every request counts against the task's declared external
  budget.
- **Disclosure**: pushing sends listing name, description, location, and date in
  plaintext to the operator's chosen server. The settings copy says this in
  plain words before the operator connects.
- **Untrusted input that causes work**: to the scheduled task, server responses
  are only ever status codes (PUT, DELETE); no response body is parsed beyond
  bounded error summaries for the sync status. The one body ever read is the
  connect-time PROPFIND response, size-capped and inspected solely to confirm
  the target is a calendar collection — never stored, never echoed. A hostile or
  broken server can only make the connect test or later pushes fail, visibly.

## Shared contract (design)

One new module family, `src/shared/caldav/`, split pure-core/thin-shell:

- `vevent.ts` — pure. Build a VEVENT from a listing, sharing (not duplicating)
  the ICS escaping/date helpers currently in `src/features/feeds.ts` — one ICS
  vocabulary — and the same public-visibility gate the `/ticket` page and feed
  use, so an event never links to a page that would 404. No parser for the sync
  path: nothing is read.
- `client.ts` — thin IO. `testConnection` (authenticated PROPFIND that must
  prove a calendar collection, then a probe event PUT and DELETE proving write
  access), `put`, `delete` over `fetch` with basic auth, the outbound guards
  above, and subrequest counting.
- `push-plan.ts` — pure. `(pendingRows, queueRows) → PushAction[]` where
  `PushAction` is an exhaustive discriminated union (`put`, `queueDelete`,
  `deleteRemote`, `dropStaleDelete`, `clearLocal` — the vacuous dateless clear —
  and `skip` with a typed reason). Every rule in the commands table lives here,
  unit-tested and mutation-tested without IO.
- One entry in `src/shared/maintenance/registry.ts` (`caldav_push`,
  `wakePolicy: "scheduled_only"`), draining the queue then pushing under its
  single claim, with `requestFollowUp` for large batches, generation-guarded
  state writes, and the durable sync status written on every pass.

Storage: two listing columns (`caldav_pending` integer revision, default 1;
`caldav_pushed_at`), a `caldav_deletes` queue table (derived href + deleted
listing id), and the settings keys (calendar URL, username, password, namespace,
settings revision, sync status).

## Adversarial review

The PR_WORKFLOW challenge questions, answered:

- **External success, local write fails?** Idempotent by identity: re-PUT
  overwrites our own content; re-DELETE 404s into success.
- **Callback replayed?** No callbacks exist; wakes replay by design and are
  no-ops via the pending/queue guards.
- **Follow-up read fails after success?** No follow-up reads exist.
- **Wrong resource id?** Identities are derived from id + immutable namespace;
  nothing is ever addressed by data a server sent us.
- **Two requests run together?** Concurrency table: claims, revision-guarded
  clears, drain-time rechecks, the settings revision, the generation guard.
- **Stale form/revision?** The pending counter guards listing sync writes; the
  settings revision guards saves; the generation guards a leased worker. Every
  stale write fails its condition and becomes a no-op or fails closed.
- **User reloads after interruption?** Save and disconnect are idempotent; sync
  state is server-side.
- **Same resource on another record?** One calendar per site; derived UIDs are
  unique per listing id.
- **One queued item fails permanently?** Isolated per item, surfaced in the
  durable sync status, never blocks the batch.
- **What does the operator see in unfinished states?** The settings page reads
  the durable sync status: connection state, last result, sanitized error,
  counts, and remaining backlog.

**History**: review rounds 1 and 2 (Codex) hardened the two-way design — see
commit `1be31c4` for that contract and its round-by-round record. Round 3
arrived alongside the owner's rescope; its findings about pull, reviews, and
patch-preservation were resolved by removing those subsystems, and its three
findings that apply to push-only are folded in above: the delete queue is
drained with an at-execution recheck and before pushes (stale date-removal
race); deletions of pushed listings are queued even while disconnected (no
orphaned events on reconnect); and the pending column's default-1 covers the
statement-based creation paths (catalog import, bulk clone) that bypass
`listingsTable.insert`. Round 4 (Codex, on this push-only revision) closed nine
holes, all folded in above: settings transitions serialize with the task claim,
so no worker fires an external call at an abandoned destination; a same-URL
reconnect re-marks stamped-but-dateless rows, preserving date-removal work
across disconnect; site-domain changes repush every dated listing so embedded
links stay live; the first-PUT/concurrent-delete race is netted by the zero-row
finalize rule; connect proves a writable calendar collection (is-calendar check
plus write probe) instead of trusting any 2xx PROPFIND; never-pushed dateless
rows clear locally in one batch, never as 404 DELETEs; a pushed row's date
removal clears pending in the same guarded transition that queues the delete, so
the backlog converges; destination changes reset the durable sync status; and
unbookable listings' events omit the public link the `/ticket` route would 404
on.

## Vertical pull request

One PR delivers the complete behavior — connect, verify, and a calendar that
mirrors listings (create, edit, delete) — with nothing dormant:

- Settings section with live verification (is-calendar check + write probe),
  claim-serialized connect/change/disconnect transitions, and plain-words copy
  about disclosure and the mirror being read-only.
- Migration: two listing columns + the delete queue table.
- `vevent.ts` build (deduped with `feeds.ts`), `client.ts`, `push-plan.ts`, the
  `caldav_push` task, durable sync status.
- Budget: ~700 source lines (grew from ~650 folding review round 4); task budget
  ~4 db + ~12 external calls per wake (chunked, follow-up for more); connect
  verification is 3 foreground external calls (PROPFIND, probe PUT, probe
  DELETE) at save time only. DB calls on listing writes: zero extra round-trips
  (the pending bump rides the existing statements).

## Tests that prove the contract

- **Pure unit (mirror-located)**: `vevent` build including escaping, the
  feed-identical field set, and the URL omitted for listings the public gate
  rejects; `push-plan` table-driven cases for every commands-table row —
  queue-before-push ordering, drop-stale-delete, date-removal queues + clears
  pending in one action, the vacuous dateless clear, skip reasons. These carry
  the mutation gate.
- **Integration (test db + stubbed `fetch`)**: push idempotency (crash after
  PUT, re-run, exactly one remote resource); revision races (edit between read
  and clear; date restored during date-removal; date restored after queue insert
  → drain drops the row); listing deleted between first PUT and finalize → the
  zero-row finalize queues the delete; delete queued while disconnected and
  drained on same-URL reconnect; date removed, disconnect, same-URL reconnect →
  the stamped dateless row is re-marked and its delete sent; destination change
  clears the queue, resets the sync status, and re-mirrors everything;
  site-domain change re-marks every dated listing; catalog-import and bulk-clone
  listings start pending, and pre-existing undated rows clear on the first wake
  without external calls; a settings save during a leased pass fails closed with
  the retry message; connect refuses a non-calendar target and a read-only
  collection (probe fails → nothing stored); stale settings save fails closed;
  401 surfacing via durable status; subrequest budget counting.
- **Regression discipline**: each behavior lands with its failing-first test per
  AGENTS.md.
- **Cucumber journey**: connect → listing appears in (stubbed) calendar → edit
  updates it → delete removes it.

## Questions for approval

The scope questions are settled (owner, PR #2064: push-only; inbound changes
ignored; no calendar creates/deletes; paste-the-address setup). Remaining:

1. **Convergence pacing**: bounded batch per 15-minute wake — a first connect on
   a site with ~100 dated listings takes a few hours to fully mirror. OK?
2. **Budget**: ~700 source lines in one PR — acceptable?
