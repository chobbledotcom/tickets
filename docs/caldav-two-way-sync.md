# CalDAV two-way sync — behavior contract

Status: **draft, awaiting human approval** (PR_WORKFLOW.md step 6). No tests or
implementation exist yet. This contract was researched against
[eventschedule](https://github.com/eventschedule/eventschedule)'s CalDAV
implementation (`app/Services/CalDAVService.php` and friends); where this design
copies or deliberately departs from theirs, the text says so.

## Current-system value

Operators today can only mirror bookings _out_ through the read-only ICS feed
(`GET /caldav/events.ics` in `src/features/feeds.ts`); nothing they do in their
own calendar ever reaches this system, and listings never appear in their
calendar as editable events. This feature makes the operator's real calendar
(Nextcloud, Fastmail, iCloud, Radicale — anything CalDAV) show every dated
listing as an event, kept current within one maintenance wake, and lets edits
made in that calendar flow back into the listings the site sells from.

Production receivers of the change:

- `/admin/settings` (owner section) — connect, verify, pick a calendar, choose a
  direction, disconnect.
- `listingsTable` in `src/shared/db/listings/records.ts` — every listing write
  marks the row for push in the same statement.
- The scheduled maintenance runner (`POST /scheduled`,
  `src/shared/maintenance/registry.ts`) — two new tasks, `caldav_push` and
  `caldav_pull`, do all external calendar IO.

## Scope

- This system is a CalDAV **client** of one operator-chosen calendar collection.
  We do not implement a CalDAV server.
- Only **dated listings** sync. Bookings/attendees remain feed-only facts owned
  by this app and are never created, updated, or deleted from a calendar
  (eventschedule enforces the same boundary for its appointment bookings after a
  data-loss incident their code comments document).
- Sync direction is an owner setting: `off` (default), `push`, `pull`, or
  `both`.
- No foreground request makes a CalDAV call. All external IO happens inside the
  two scheduled tasks, so the calendar converges within roughly one wake (15
  minutes on the default monitor cadence) rather than instantly. eventschedule
  pushes inline in the request; we trade that latency for a single retry owner
  and no new failure modes on listing writes.

## Trusted facts

Expected facts (ours) and observed facts (the server's) stay separate.

| Fact                                          | Why it may be trusted                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server URL, username, app password            | Operator-entered, verified by a live PROPFIND before saving. Stored as encrypted settings. Expected, not proof of later success.                  |
| Calendar URL                                  | Chosen from a server-provided discovery list (or pasted), re-verified at save. Expected fact.                                                     |
| A listing row and its `caldav_pending` rev    | Written transactionally by `listingsTable`; the pending counter is authoritative for "local changes not yet pushed".                              |
| Pushed event identity `listing-{id}@{domain}` | Deterministic — derived from the listing id and effective domain, the same UID scheme the public feed already emits. Never stored, never guessed. |
| A stored per-listing etag                     | Observed fact from a REPORT/PROPFIND response. Proves what version we last saw, not what the server holds now.                                    |
| The collection ctag / sync-token              | Observed fact. Equality with the stored token proves nothing changed since the last **fully successful** pull pass.                               |
| A REPORT response body                        | Untrusted external input from the configured server. Parsed strictly at the boundary; malformed items fail loudly per item.                       |
| An HTTP 2xx on PUT                            | Proves the server accepted **that** write. Does not prove a later read succeeds, and may not include an ETag header.                              |
| An HTTP 404 on DELETE                         | Proves the resource is already gone — success for our purposes.                                                                                   |

Never substitute an expected fact for a missing observed fact: a listing is
"synced" only once a pull has observed its etag.

## Valid states

Site-level connection state (settings-backed):

```typescript
type CalDavConnection =
  | { kind: "disconnected" }
  | {
    kind: "configured";
    direction: "push" | "pull" | "both";
    // Credentials verified by a live test at save time.
    serverUrl: string;
    calendarUrl: string;
    // Null until the first fully successful pull pass.
    ctag: string | null;
  };
```

Per-listing sync state, derived from three columns (`caldav_pending` integer
revision counter, `caldav_etag`, and a `caldav_reviews` row):

| State                | Facts required                                      | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `unsynced`           | pending = 0, etag null, no review row               | No remote copy expected (sync off, or listing has no date).                                                           |
| `pending_push`       | pending > 0                                         | Local changes not yet on the calendar. Takes precedence: inbound updates are skipped while pending.                   |
| `pushed_unconfirmed` | pending = 0, etag null, PUT succeeded at some point | On the calendar, but no pull has observed its etag yet.                                                               |
| `synced`             | pending = 0, etag non-null                          | Both sides aligned as of the etag we hold.                                                                            |
| `needs_review`       | review row exists                                   | An inbound change was held for the operator (listing has bookings, or remote deletion under the `deactivate` policy). |

Pull-created listings additionally carry the foreign UID (`caldav_uid`,
encrypted, with a `caldav_uid_index` blind HMAC column for lookups — the same
pattern as listing slugs). Listings we pushed need no stored UID: identity is
derived. An unavailable read is not "unchanged"; a missing etag is not an empty
etag.

## Commands and events

| Starting state                                                | Command or event                            | Required result                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disconnected                                                  | Owner saves settings (live test passes)     | configured; if direction includes push, every dated listing gets pending bumped so the next wake uploads them all.                                                                                                                                                                                                                                                        |
| disconnected                                                  | Owner saves settings (live test fails)      | Nothing stored; the error is shown. No partial credentials.                                                                                                                                                                                                                                                                                                               |
| configured                                                    | Owner changes direction                     | Direction updated. Switching push on bumps pending on all dated listings; switching pull off clears no state.                                                                                                                                                                                                                                                             |
| configured                                                    | Owner disconnects                           | Credentials, ctag, all etags, foreign UID mappings, and review rows cleared. Remote events stay on the calendar (documented; matches eventschedule).                                                                                                                                                                                                                      |
| any                                                           | Listing created/updated via `listingsTable` | `caldav_pending = caldav_pending + 1` in the same statement. No external call.                                                                                                                                                                                                                                                                                            |
| any                                                           | Listing deleted                             | A `caldav_deletes` queue row (the event's UID) written in the same batch as the delete.                                                                                                                                                                                                                                                                                   |
| configured (push)                                             | `caldav_push` wake                          | For each pending dated listing (bounded batch): build VEVENT, PUT to `{calendarUrl}/{uid}.ics`, then clear pending **only if the revision is unchanged** (`WHERE caldav_pending = readValue`). Pending listing whose date was removed: queue a delete, clear etag. Then drain the delete queue (DELETE, 404 = success, remove row). More work left → `requestFollowUp()`. |
| configured (pull)                                             | `caldav_pull` wake                          | PROPFIND ctag; equal to stored → done (1 external call). Else REPORT (etag + calendar data, bounded time window), apply per-VEVENT rules below, then store the new ctag **only after a fully error-free pass**.                                                                                                                                                           |
| pull: VEVENT, known id, same etag                             | —                                           | Skip (fast path).                                                                                                                                                                                                                                                                                                                                                         |
| pull: VEVENT, known id, changed etag                          | —                                           | pending > 0 → skip (local wins; push will overwrite). Listing has attendees and date/name changed → write a review row, do not touch the listing. Otherwise apply guarded update (name from SUMMARY, date from DTSTART as UTC; description/location only when non-empty — an emptied remote field never blanks a local one) with `WHERE caldav_pending = 0`, store etag.  |
| pull: VEVENT, unknown UID                                     | —                                           | Per owner policy: ignore (default), or create an **inactive** listing (name, date, description, location; no prices) storing the foreign UID + etag.                                                                                                                                                                                                                      |
| pull: VEVENT with RRULE / RECURRENCE-ID / no UID / no DTSTART | —                                           | Skip; count and surface in sync status. (eventschedule flattens recurring events to one instance — we refuse instead of corrupting.)                                                                                                                                                                                                                                      |
| pull: previously-synced listing absent from REPORT            | —                                           | Deletion detected only when the listing's date is inside the queried window, etag is non-null, and pending = 0. Per owner policy: ignore (default), or deactivate + review row. Never hard-delete; bookings untouched.                                                                                                                                                    |
| needs_review                                                  | Operator edits the listing or dismisses     | Review row cleared. An edit bumps pending, so push re-asserts the local truth to the calendar.                                                                                                                                                                                                                                                                            |

Every command has one authoritative implementation: the pure planner
(`sync-plan.ts`, below) decides; thin IO applies.

## Failure table

| Work completed                          | Failure                       | Required result                                                                                                                                           | Retry owner        |
| --------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Nothing                                 | Save-settings live test fails | No settings stored; operator sees the error.                                                                                                              | Operator           |
| Listing write committed                 | (no external work in-request) | Pending counter is durable; calendar catches up on a later wake.                                                                                          | `caldav_push` task |
| PUT succeeded                           | Pending-clear write fails     | Task fails; next wake re-PUTs the same deterministic UID — an idempotent overwrite, never a duplicate.                                                    | `caldav_push` task |
| Some PUTs done                          | A later PUT fails             | Completed rows stay cleared; the failed row stays pending; task reports failure, retries at `failureRetryIntervalMs`. One bad row never blocks the rest.  | `caldav_push` task |
| REPORT fetched, some rows applied       | A later row fails             | Applied rows keep their new etags (committed per row); ctag **not** advanced, so the next wake reprocesses — cheap, because unchanged rows skip via etag. | `caldav_pull` task |
| DELETE sent                             | 404                           | Success; queue row removed.                                                                                                                               | —                  |
| Anything                                | 401/403 (credentials revoked) | Task failure every wake; last result + error shown on the settings page so the operator can fix credentials.                                              | Operator           |
| Deactivate-on-remote-delete write fails | —                             | Task failure; the UID is still absent remotely, so the next wake re-detects and retries.                                                                  | `caldav_pull` task |

The external-success/local-failure gap is closed by identity, not bookkeeping:
because the PUT target is derived from the listing id, losing the local write
after a remote success costs one redundant idempotent PUT, nothing more.
(eventschedule mints a random UUID per attempt; a crash between PUT and storing
it duplicates the event on the calendar. Ours cannot.)

## Retry and replay table

| Question                         | `caldav_push`                                                                                           | `caldav_pull`                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Stable identity                  | `listing-{id}@{domain}` — deterministic PUT target.                                                     | Remote UID; per-listing etag; collection ctag.                               |
| Exact replay returns             | Same-bytes PUT to the same URL: server overwrites in place, no visible change.                          | Same etag → skip; same missing UID → same policy decision.                   |
| Who retries after interruption   | Next scheduled wake (pending rows persist).                                                             | Next scheduled wake (ctag only stored after a clean pass).                   |
| What stops two workers           | Maintenance claims (`claimNextMaintenanceTask`) — one runner per task.                                  | Same.                                                                        |
| Permanent failures               | A PUT the server always rejects: row stays pending, surfaced in sync status; does not block other rows. | Malformed VEVENT: skipped and counted every pass; does not block other rows. |
| Can one failed item block others | No — per-item isolation; the task still reports failure so retry happens.                               | No — same.                                                                   |

## Concurrency table

| Operation A                    | Operation B                          | Required result                                               | Protection                                                                                                                                              |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push task PUTs listing content | Operator edits the same listing      | The newer edit is pushed on a later wake, never lost.         | Pending is a **revision counter**: the edit bumps it; push clears with `WHERE caldav_pending = readValue`, so a bump after the read survives the clear. |
| Pull applies an inbound update | Operator edits the same listing      | The operator's edit wins; remote is overwritten on next push. | Inbound apply runs `WHERE caldav_pending = 0`; a concurrent bump makes it a no-op skip.                                                                 |
| Two scheduled wakes overlap    | —                                    | One runner per task.                                          | Maintenance claim rows.                                                                                                                                 |
| Push and pull run in one wake  | —                                    | Order-independent.                                            | Pull skips pending rows; push never reads or writes etags.                                                                                              |
| Pull runs before first push    | New listing pending, absent remotely | Not treated as remotely deleted.                              | Deletion detection requires etag non-null **and** pending = 0.                                                                                          |

## Owner choices

Genuine conflicts the system must not decide silently:

1. **Events created on the calendar** (unknown UID): `ignore` (default) or
   `create as inactive listing`. A listing is a bookable product; nothing
   created from a bare calendar entry is ever active or priced until the
   operator finishes it.
2. **Remote deletion of a synced listing**: `ignore` (default) or
   `deactivate and hold for review`. Hard-deleting locally is never offered — a
   listing can carry bookings and money history (eventschedule guards
   revenue-bearing events the same way).
3. **Inbound date/name changes to a listing with attendees**: always held for
   review, not configurable. Someone booked the listing as it was; only the
   operator may confirm the change. The review notice links the listing's edit
   page; accepting = editing the listing (which pushes back out), dismissing =
   keeping local state (which also pushes back out, re-asserting it).

Documented non-choices: disconnecting leaves previously pushed events on the
calendar; bookings never sync; recurring events are skipped.

## Security and privacy

- **Who**: only `owner`-level admins see the CalDAV settings section, sync
  status, and review notices. No CalDAV surface exists for managers, agents, or
  delivery roles, and no links to it are rendered for them.
- **Secrets**: server URL, username, password, and calendar URL are stored via
  `encryptedUpdate` settings (the Stripe-key pattern). The password field is
  write-only in the UI — never echoed back. Test-connection uses the submitted
  values, not stored ones.
- **Outbound guard**: HTTPS only; redirects never followed; the host must be a
  name, not an IP literal or localhost; credentials travel only in the
  basic-auth header. Every request the client makes counts against the
  maintenance task's declared external budget.
- **Inbound guard**: multistatus XML and VEVENT bodies are untrusted input from
  the configured server. Bounded response sizes, strict per-item parsing
  (valibot at the boundary), loud per-item failure. Parsed text lands in the
  same encrypted listing columns as operator-typed text and is escaped at render
  time like any listing field.
- **Disclosure**: pushing sends listing name, description, location, and date in
  plaintext to the operator's chosen server. The settings copy says this in
  plain words before the operator connects.
- **Untrusted input that causes work**: a hostile/buggy server can at most make
  us skip items or fail the task; it cannot delete listings (deletion is
  policy-gated, review-held, and never hard), cannot touch bookings or money,
  and cannot redirect requests elsewhere.

## Shared contract (design)

One new module family, `src/shared/caldav/`, split pure-core/thin-shell:

- `vevent.ts` — pure. Build a VEVENT from a listing; parse a VEVENT into a
  typed, valibot-validated record (UID, SUMMARY, DTSTART with TZID normalized to
  UTC, DTEND, DESCRIPTION, LOCATION, RRULE flag). Absorbs and shares the ICS
  escaping/date helpers currently in `src/features/feeds.ts` — one ICS
  vocabulary, no parallel implementation.
- `multistatus.ts` — pure. Parse PROPFIND/REPORT multistatus XML into typed rows
  (href, etag, calendar-data, ctag, displayname, resourcetype). Strict and
  bounded; no regex-scraping of XML (eventschedule's approach).
- `client.ts` — thin IO. `propfind` / `report` / `put` / `delete` over `fetch`
  with basic auth, the outbound guards above, and subrequest counting. Also
  calendar discovery (principal → home set → calendar list) for the settings UI.
- `sync-plan.ts` — pure, the heart.
  `(localRows, remoteRows, policies) →
  SyncAction[]` where `SyncAction` is an
  exhaustive discriminated union (`put`, `delete`, `applyUpdate`,
  `holdForReview`, `createInactive`, `deactivate`, `skip` with a typed reason).
  Every rule in the commands table lives here, unit-tested and mutation-tested
  without IO.
- Two entries in `src/shared/maintenance/registry.ts`
  (`wakePolicy:
  "scheduled_only"`), applying planned actions through the thin
  shell with checkpoints and `requestFollowUp` for large batches.

Storage: three listing columns (`caldav_pending` integer revision, `caldav_etag`
text, `caldav_uid`/`caldav_uid_index` encrypted + blind index, foreign-created
rows only), a `caldav_deletes` queue table, a `caldav_reviews` table (listing
id, kind, held remote values encrypted, created), and the settings keys named
above.

## Adversarial review

The PR_WORKFLOW challenge questions, answered:

- **External success, local write fails?** Idempotent by identity — see the
  failure table. Re-PUT overwrites; re-DELETE 404s.
- **Callback replayed?** No callbacks exist; wakes replay by design and are
  no-ops via etag/ctag/pending guards.
- **Follow-up read fails after success?** Push never needs a follow-up read
  (etag arrives later via pull). Pull failing mid-pass leaves ctag stale, so the
  pass repeats.
- **Wrong resource id?** PUT targets are derived, not stored, so a stored-id
  corruption class doesn't exist for pushed events. A foreign UID mismatch means
  "unknown UID" → policy-gated create, never an overwrite of the wrong row.
- **Two requests run together?** Concurrency table: revision-guarded clears and
  `pending = 0`-guarded applies; claims serialize the tasks.
- **Stale form/revision?** The pending counter is the revision; a stale clear or
  stale inbound apply fails its `WHERE` and becomes a no-op.
- **User reloads after interruption?** All operator actions (save settings,
  disconnect, dismiss review) are idempotent; sync state is server-side.
- **Same resource on another record?** One calendar per site and UID uniqueness
  per collection; a foreign UID maps to at most one listing via the blind index
  (unique).
- **One queued item fails permanently?** Isolated per item, surfaced in sync
  status, never blocks the batch.
- **What does the operator see in unfinished states?** Settings page shows
  connection state, last push/pull result, error text on failure, skip counts,
  and pending review notices; listings pages badge `needs_review` rows.

Open judgement calls are in "Questions for approval" — nothing else is left
implicit.

## Vertical pull requests

Each slice is a complete behavior, independently green and useful; each includes
the tests proving its rows and deletes any path it replaces.

1. **Connect, verify, and choose a calendar.** Settings section (owner-only),
   `client.ts` + `multistatus.ts` + discovery, live test at save, disconnect.
   Value: an operator can securely connect and validate today. Budget: ~450
   source lines; DB: settings reads/writes only; external: ≤4 calls per settings
   save.
2. **Push.** Pending revision column + delete queue migration, `vevent.ts` build
   side (deduped with `feeds.ts`), `caldav_push` task. Value: the operator's
   real calendar mirrors listings — create, edit, delete. Budget: ~400 source
   lines; task budget ~2 db + ~10 external per wake (chunked, follow-up for
   more).
3. **Pull updates.** ctag fast path, REPORT, `vevent.ts` parse side,
   `sync-plan.ts`, guarded applies, bookings-hold review rows + notice UI.
   Value: calendar edits flow back safely. Budget: ~500 source lines; task
   budget ~2 external + bounded db per wake.
4. **Remote create and delete policies.** The two owner choices, their plan
   arms, and their notices. Value: full two-way parity with eventschedule, minus
   its unsafe corners. Budget: ~250 source lines.

Slices 1→2 and 3→4 are natural stack layers (`gh stack`) if reviewed together.

## Tests that prove the contract

- **Pure unit (mirror-located)**: `vevent` build/parse round-trip including
  escaping, TZID→UTC, RRULE/no-UID/no-DTSTART skips; `multistatus` parsing
  against fixtures shaped like Radicale, Nextcloud, and Fastmail responses plus
  hostile/oversized input; `sync-plan` table-driven cases for every
  commands-table row (skip/update/hold/create/deactivate/delete), including the
  pending-precedence and deletion-window rules. These carry the mutation gate.
- **Integration (test db + stubbed `fetch`)**: push idempotency (crash after
  PUT, re-run, exactly one remote resource); revision race (edit between read
  and clear survives); pull applies with `pending = 0` guard; ctag stored only
  after a clean pass; per-item failure isolation; subrequest budget counting;
  401 surfacing.
- **Regression discipline**: each behavior lands with its failing-first test per
  AGENTS.md.
- **Cucumber journey**: connect → listing appears in (stubbed) calendar → remote
  edit pulls back → booking-bearing listing change is held for review.

## Questions for approval

1. **Convergence latency**: is "within ~15 minutes" acceptable, or do you want
   best-effort inline push on listing writes as a later enhancement?
2. **Slice 4 in v1?** Remote-created events and deletion policies could ship
   later; defaults (`ignore`/`ignore`) make slices 1–3 complete without them.
3. **Review-hold bar**: held when the listing **has attendees** — or should any
   _active_ listing's inbound date change be held too?
4. **REPORT window**: proposing −30 days … +400 days (a named constant). Events
   outside it are invisible to pull and exempt from deletion detection. OK?
5. **Budgets**: the source-line estimates above — acceptable?
