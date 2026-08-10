# CalDAV two-way sync — behavior contract

Status: **draft, awaiting human approval** (PR_WORKFLOW.md step 6). No tests or
implementation exist yet. This contract was researched against
[eventschedule](https://github.com/eventschedule/eventschedule)'s CalDAV
implementation (`app/Services/CalDAVService.php` and friends); where this design
copies or deliberately departs from theirs, the text says so. Revision 2
incorporates the first adversarial review round (Codex, PR #2064) — the
[Adversarial review](#adversarial-review) section records what changed.

## Current-system value

Operators today can only mirror bookings _out_ through the read-only ICS feed
(`GET /caldav/events.ics` in `src/features/feeds.ts`); nothing they do in their
own calendar ever reaches this system, and listings never appear in their
calendar as editable events. This feature makes the operator's real calendar
(Nextcloud, Fastmail, iCloud, Radicale — anything CalDAV) show every dated
listing as an event, kept current by the scheduled maintenance cycle, and lets
edits made in that calendar flow back into the listings the site sells from.

Production receivers of the change:

- `/admin/settings` (owner section) — connect, verify, pick a calendar, choose a
  direction, disconnect.
- `listingsTable` in `src/shared/db/listings/records.ts` — every listing write
  marks the row for push in the same statement while push is enabled.
- The scheduled maintenance runner (`POST /scheduled`,
  `src/shared/maintenance/registry.ts`) — one new task, `caldav_sync`, does all
  external calendar IO.

## Scope

- This system is a CalDAV **client** of one operator-chosen calendar collection.
  We do not implement a CalDAV server.
- Only **dated listings** sync. Bookings/attendees remain feed-only facts owned
  by this app and are never created, updated, or deleted from a calendar
  (eventschedule enforces the same boundary for its appointment bookings after a
  data-loss incident their code comments document).
- Sync direction is an owner setting: `off` (default), `push`, `pull`, or
  `both`.
- No foreground request makes a CalDAV call. All external IO happens inside one
  scheduled task, a bounded batch per wake. Steady-state edit volume converges
  in one wake (15 minutes on the default monitor cadence); a large backlog —
  first connect, or a direction switch, on a site with many dated listings —
  takes several wakes, and the sync status says so rather than pretending
  otherwise. eventschedule pushes inline in the request; we trade latency for a
  single retry owner and no new failure modes on listing writes.

## Trusted facts

Expected facts (ours) and observed facts (the server's) stay separate.

| Fact                                             | Why it may be trusted                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server URL, username, app password               | Operator-entered, verified by a live PROPFIND before saving. Stored as encrypted settings. Expected, not proof of later success.                             |
| Calendar URL                                     | Chosen from a server-provided discovery list (or pasted), re-verified at save. Expected fact.                                                                |
| The UID namespace                                | A random token minted once at connect and stored in settings. Immutable for the life of the connection, so pushed identities survive a custom-domain change. |
| Pushed event identity `listing-{id}@{namespace}` | Deterministic — derived from the listing id and the stored namespace. Never guessed; the href we PUT to is the one we derived.                               |
| A foreign event's href + UID                     | Observed facts from a REPORT. The href, not the UID, addresses the resource (RFC 4791 does not promise `{uid}.ics`), so both are stored for foreign rows.    |
| A listing row and its `caldav_pending` rev       | Written transactionally by `listingsTable`; the pending counter is authoritative for "local changes not yet pushed".                                         |
| A stored per-listing etag                        | Observed fact from a REPORT/PROPFIND response. Proves what version we last saw, not what the server holds now.                                               |
| The collection ctag / sync-token                 | Observed fact. Equality with the stored token proves nothing changed since the last **fully successful** pull pass.                                          |
| A REPORT response body                           | Untrusted external input from the configured server. Parsed strictly at the boundary; malformed items fail loudly per item.                                  |
| An HTTP 2xx on PUT                               | Proves the server accepted **that** write. Does not prove a later read succeeds, and may not include an ETag header.                                         |
| An HTTP 404 on GET/DELETE of a resource          | Proves the resource is gone — the only fact deletion detection may act on.                                                                                   |

Never substitute an expected fact for a missing observed fact: a listing is
"synced" only once a pull has observed its etag, and an absence from a windowed
REPORT is never treated as a deletion (see the commands table).

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
    // Minted at connect; never changes while configured.
    uidNamespace: string;
    // Null until the first fully successful pull pass.
    ctag: string | null;
  };
```

Per-listing sync state, derived from four columns (`caldav_pending` integer
revision counter, `caldav_pushed_at`, `caldav_etag`, and a `caldav_reviews`
row):

| State                | Facts required                             | Meaning                                                                                                                                             |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsynced`           | pending = 0, pushed_at null, etag null     | No remote copy expected (sync off, or listing has no date).                                                                                         |
| `pending_push`       | pending > 0 (push enabled)                 | Local changes not yet on the calendar. Takes precedence: inbound updates are skipped while pending.                                                 |
| `pushed_unconfirmed` | pending = 0, pushed_at non-null, etag null | On the calendar (we PUT it), but no pull has observed its etag yet. Push **sets pushed_at and nulls etag** — a pre-PUT etag is stale by definition. |
| `synced`             | pending = 0, etag non-null                 | Both sides aligned as of the etag we hold.                                                                                                          |
| `needs_review`       | review row exists                          | An inbound change was held for a human (listing has bookings, or remote deletion under the `deactivate` policy).                                    |

Pull-created listings additionally carry the foreign identity (`caldav_uid` and
`caldav_href`, both encrypted, with a `caldav_uid_index` blind HMAC column for
lookups — the same pattern as listing slugs). Listings we pushed need no stored
identity: UID and href are derived from id + namespace. An unavailable read is
not "unchanged"; a missing etag is not an empty etag.

The pending counter is **push bookkeeping and exists only while push is
enabled**. In pull-only mode listing writes do not bump it (nothing would ever
consume the revision, and the pull-skip rule would freeze the listing out of
sync forever); the conflict rule for pull-only is that the calendar wins for
plain listings — the operator chose that direction — while the review holds
below still protect booking-bearing listings.

## Commands and events

| Starting state                                                                       | Command or event                            | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disconnected                                                                         | Owner saves settings (live test passes)     | configured; namespace minted; if direction includes push, every dated listing gets pending bumped. The final write requires the CalDAV settings revision the form rendered with — a stale save fails closed with "settings changed, reload".                                                                                                                                                                                                                                                                                                                    |
| disconnected                                                                         | Owner saves settings (live test fails)      | Nothing stored; the error is shown. No partial credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| configured                                                                           | Owner changes server URL or calendar URL    | An atomic disconnect-then-connect: ctag, every etag and pushed_at, foreign uid/href mappings, and review rows are cleared (they were observations of the old collection); a new namespace is minted; pending bumped on all dated listings when push is enabled. Events on the old calendar stay there (documented).                                                                                                                                                                                                                                             |
| configured                                                                           | Owner switches push on (from off/pull)      | Pending bumped on all dated listings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| configured                                                                           | Owner switches push off                     | All pending counters zeroed — they mean "awaiting push" and nothing would consume them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| configured                                                                           | Owner disconnects                           | Credentials, ctag, namespace, etags, pushed_at stamps, foreign mappings, and review rows cleared. Remote events stay on the calendar (documented; matches eventschedule).                                                                                                                                                                                                                                                                                                                                                                                       |
| any, push enabled                                                                    | Listing created/updated via `listingsTable` | `caldav_pending = caldav_pending + 1` in the same statement. No external call. (Inbound applies are the one exception — sync bookkeeping, not an operator change, so they never bump pending.)                                                                                                                                                                                                                                                                                                                                                                  |
| any                                                                                  | Listing deleted                             | While push is enabled: a `caldav_deletes` queue row (derived or stored href) written in the same batch as the delete.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| configured                                                                           | `caldav_sync` wake                          | One claimed task, two phases in order: **push phase** then **pull phase** (each active only if the direction includes it). Serializing them in one claim is what makes the interleavings below impossible.                                                                                                                                                                                                                                                                                                                                                      |
| push phase                                                                           | Pending dated listing, never pushed         | Build VEVENT, PUT to the derived href, then set pushed_at, null the etag, and clear pending — all guarded by `WHERE caldav_pending = readValue`, so an edit during the PUT survives and repushes.                                                                                                                                                                                                                                                                                                                                                               |
| push phase                                                                           | Pending dated listing, pushed before        | GET the current resource, replace only the fields we own (SUMMARY, DTSTART, DESCRIPTION, LOCATION, DTSTAMP, LAST-MODIFIED), **preserve every other property and sub-component verbatim** (VALARM, ATTENDEE, categories…), PUT back, then the same guarded clear. A 404 on the GET means it vanished remotely: fall back to a create-PUT.                                                                                                                                                                                                                        |
| push phase                                                                           | Pending listing whose date was removed      | Queue a delete and null etag/pushed_at, guarded by `WHERE caldav_pending = readValue AND date = ''` — a date restored mid-task survives, stays pending, and repushes next wake.                                                                                                                                                                                                                                                                                                                                                                                 |
| push phase                                                                           | Delete queue rows                           | DELETE each href; 404 = success; remove the row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| pull phase                                                                           | Stored ctag equals the collection's         | Done — one external call for the whole phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| pull phase                                                                           | ctag differs                                | REPORT (etag + calendar data, bounded time window), apply the per-VEVENT rules below, then store the new ctag **only after a fully error-free pass**.                                                                                                                                                                                                                                                                                                                                                                                                           |
| pull: VEVENT, known listing, same etag                                               | —                                           | Skip (fast path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| pull: VEVENT, known listing, changed etag                                            | —                                           | pending > 0 → skip (local wins; the next push phase overwrites). Listing has attendees and date/name changed → write a review row, touch nothing else. Parsed fields equal to local values → store etag only (no listing write, no churn). Otherwise apply the guarded update (name from SUMMARY, date from DTSTART; description/location only when non-empty — an emptied remote field never blanks a local one) with `WHERE caldav_pending = 0`, without bumping pending, and store the etag.                                                                 |
| pull: VEVENT, unknown UID                                                            | —                                           | Per owner policy: ignore (default), or create an **inactive** listing (name, date, description, location; no prices) storing the foreign UID, href, and etag.                                                                                                                                                                                                                                                                                                                                                                                                   |
| pull: VEVENT with RRULE / RECURRENCE-ID / VALUE=DATE (all-day) / no UID / no DTSTART | —                                           | Skip; count and surface in sync status. (eventschedule flattens recurring events to one instance — we refuse instead of corrupting. All-day events don't map onto a timed listing.) A **floating** DTSTART — no TZID, no Z — is interpreted in the site's configured timezone, not skipped.                                                                                                                                                                                                                                                                     |
| pull: previously-synced listing absent from REPORT                                   | —                                           | Absence alone proves nothing (the event may have been moved outside the window). Candidates — etag non-null, pending = 0, local date inside the window, bounded per pass — are confirmed by a **direct GET of the resource**: 404 → apply the owner's deletion policy (ignore, or deactivate + review row; never hard-delete; bookings untouched); 200 → treat its body as an ordinary inbound update.                                                                                                                                                          |
| needs_review                                                                         | A human resolves the review                 | Explicit action on the review surface, never a silent side effect: **accept** applies the held values through the normal listing edit path; **keep ours** stores the held etag (so the same change is not re-held) and bumps pending when push is enabled, re-asserting local state to the calendar. In pull-only mode "keep ours" stores the etag and the divergence is documented on the review surface. An ordinary listing edit does **not** clear a review row — the row's banner on the edit page shows the held remote values until someone resolves it. |

Every command has one authoritative implementation: the pure planner
(`sync-plan.ts`, below) decides; thin IO applies.

## Failure table

| Work completed                          | Failure                       | Required result                                                                                                                                           | Retry owner        |
| --------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Nothing                                 | Save-settings live test fails | No settings stored; operator sees the error.                                                                                                              | Operator           |
| Listing write committed                 | (no external work in-request) | Pending counter is durable; calendar catches up on a later wake.                                                                                          | `caldav_sync` task |
| GET-before-update succeeded             | PUT fails                     | Row stays pending (clear never ran); retried next wake.                                                                                                   | `caldav_sync` task |
| PUT succeeded                           | Pending-clear write fails     | Task fails; next wake re-runs the same derived-identity PUT — an idempotent overwrite, never a duplicate.                                                 | `caldav_sync` task |
| Some PUTs done                          | A later PUT fails             | Completed rows stay cleared; the failed row stays pending; task reports failure, retries at `failureRetryIntervalMs`. One bad row never blocks the rest.  | `caldav_sync` task |
| REPORT fetched, some rows applied       | A later row fails             | Applied rows keep their new etags (committed per row); ctag **not** advanced, so the next wake reprocesses — cheap, because unchanged rows skip via etag. | `caldav_sync` task |
| Deletion-candidate GET                  | Network error                 | Not 404 — no deletion action; candidate re-checked next wake.                                                                                             | `caldav_sync` task |
| DELETE sent                             | 404                           | Success; queue row removed.                                                                                                                               | —                  |
| Anything                                | 401/403 (credentials revoked) | Task failure every wake; the durable sync status records it so the settings page shows it.                                                                | Operator           |
| Deactivate-on-remote-delete write fails | —                             | Task failure; the resource still GETs 404 next wake, so it is re-detected and retried.                                                                    | `caldav_sync` task |

Every task pass ends by writing a **durable sync status** (a settings key:
per-phase timestamp, ok/failed, sanitized bounded error summary, and counts —
pushed, applied, held, skipped by reason). That write is inside the task's
database budget; without it a scheduled-request failure would be invisible to
the operator, who only ever sees the settings page.

The external-success/local-failure gap is closed by identity, not bookkeeping:
because the PUT target is derived, losing the local write after a remote success
costs one redundant idempotent PUT, nothing more. (eventschedule mints a random
UUID per attempt; a crash between PUT and storing it duplicates the event on the
calendar. Ours cannot.)

## Retry and replay table

| Question                         | Push phase                                                                                     | Pull phase                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Stable identity                  | `listing-{id}@{namespace}` and its derived href; stored href for foreign rows.                 | Remote href + UID; per-listing etag; collection ctag.             |
| Exact replay returns             | Same-bytes PUT to the same href: server overwrites in place, no visible change.                | Same etag → skip; same missing UID → same policy decision.        |
| Who retries after interruption   | Next scheduled wake (pending rows persist).                                                    | Next scheduled wake (ctag only stored after a clean pass).        |
| What stops two workers           | One maintenance claim covers both phases (`claimNextMaintenanceTask`) — one runner, one order. | Same claim.                                                       |
| Permanent failures               | A PUT the server always rejects: row stays pending, surfaced in sync status; blocks nothing.   | Malformed VEVENT: skipped and counted every pass; blocks nothing. |
| Can one failed item block others | No — per-item isolation; the task still reports failure so retry happens.                      | No — same.                                                        |

## Concurrency table

| Operation A                         | Operation B                          | Required result                                                                                                        | Protection                                                                                                                                                               |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Push PUTs listing content           | Operator edits the same listing      | The newer edit is pushed on a later wake, never lost.                                                                  | Pending is a **revision counter**: the edit bumps it; every push-side write clears with `WHERE caldav_pending = readValue`, so a bump after the read survives the clear. |
| Date-removal queues a remote delete | Operator restores the date           | No stale delete; the listing repushes.                                                                                 | The queue insert and etag/pushed_at clear run `WHERE caldav_pending = readValue AND date = ''`.                                                                          |
| Pull applies an inbound update      | Operator edits the same listing      | The operator's edit wins; remote is overwritten on next push.                                                          | Inbound apply runs `WHERE caldav_pending = 0`; a concurrent bump makes it a no-op skip.                                                                                  |
| Push phase                          | Pull phase                           | Pull always observes the world push left behind — a pull can never apply a REPORT that predates the pass's own pushes. | Both phases run inside **one claimed task**, push first. Two wakes cannot interleave them because claims serialize.                                                      |
| Two scheduled wakes overlap         | —                                    | One runner.                                                                                                            | Maintenance claim rows.                                                                                                                                                  |
| Pull runs before first push         | New listing pending, absent remotely | Not treated as remotely deleted.                                                                                       | Deletion candidacy requires etag non-null **and** pending = 0, and is confirmed only by a direct 404.                                                                    |
| Two owners save CalDAV settings     | —                                    | The later-rendered form wins; the stale one fails closed.                                                              | The save carries the CalDAV settings revision it rendered with; the final write requires it to still match.                                                              |

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
   review, not configurable. Someone booked the listing as it was; only a human
   may confirm the change, through the explicit accept / keep-ours review
   actions — a plain listing edit never resolves a review by side effect, so a
   manager who edits without seeing the banner cannot silently overrule a held
   conflict.

Documented non-choices: disconnecting (or changing calendar) leaves previously
pushed events on the old calendar; bookings never sync; recurring and all-day
events are skipped inbound.

## Security and privacy

- **Who**: the CalDAV settings section (credentials, direction, policies,
  disconnect) is `owner`-only, and no link to it is rendered for other roles.
  Review notices and their accept / keep-ours actions are visible to every admin
  level that can edit listings (owner and manager) — the held values are listing
  content those roles already control, and hiding the banner from the people
  editing the listing is what would let a conflict be resolved blindly. Agents
  and delivery roles see no CalDAV surface at all.
- **Secrets**: server URL, username, password, and calendar URL are stored via
  `encryptedUpdate` settings (the Stripe-key pattern). The password field is
  write-only in the UI — never echoed back. Test-connection uses the submitted
  values, not stored ones.
- **Outbound guard**: HTTPS only; redirects never followed; the host must be a
  name, not an IP literal or localhost; credentials travel only in the
  basic-auth header. Every request counts against the task's declared external
  budget.
- **Inbound guard**: multistatus XML and VEVENT bodies are untrusted input from
  the configured server. Bounded response sizes, strict per-item parsing
  (valibot at the boundary), loud per-item failure. Parsed text lands in the
  same encrypted listing columns as operator-typed text and is escaped at render
  time like any listing field. The sync status stores sanitized summaries (codes
  and counts), never raw server responses.
- **Disclosure**: pushing sends listing name, description, location, and date in
  plaintext to the operator's chosen server. The settings copy says this in
  plain words before the operator connects.
- **Untrusted input that causes work**: a hostile/buggy server can at most make
  us skip items or fail the task; it cannot delete listings (deletion is
  404-confirmed, policy-gated, review-held, and never hard), cannot touch
  bookings or money, and cannot redirect requests elsewhere.

## Shared contract (design)

One new module family, `src/shared/caldav/`, split pure-core/thin-shell:

- `vevent.ts` — pure. Build a VEVENT from a listing; parse a VEVENT into a
  typed, valibot-validated record (UID, SUMMARY, DTSTART with TZID→UTC and
  floating→site-timezone, DTEND, DESCRIPTION, LOCATION, RRULE/all-day flags);
  and **patch** an existing raw VEVENT — replace only the fields we own,
  round-tripping every other property and sub-component byte-preserved, so a
  push can never strip alarms or attendees from a calendar event. Absorbs and
  shares the ICS escaping/date helpers currently in `src/features/feeds.ts` —
  one ICS vocabulary, no parallel implementation.
- `multistatus.ts` — pure. Parse PROPFIND/REPORT multistatus XML into typed rows
  (href, etag, calendar-data, ctag, displayname, resourcetype). Strict and
  bounded; no regex-scraping of XML (eventschedule's approach).
- `client.ts` — thin IO. `propfind` / `report` / `get` / `put` / `delete` over
  `fetch` with basic auth, the outbound guards above, and subrequest counting.
  Also calendar discovery (principal → home set → calendar list) for the
  settings UI.
- `sync-plan.ts` — pure, the heart.
  `(localRows, remoteRows, policies) →
  SyncAction[]` where `SyncAction` is an
  exhaustive discriminated union (`putNew`, `patchExisting`, `deleteRemote`,
  `confirmDeletion`, `applyUpdate`, `storeEtagOnly`, `holdForReview`,
  `createInactive`, `deactivate`, `skip` with a typed reason). Every rule in the
  commands table lives here, unit-tested and mutation-tested without IO.
- One entry in `src/shared/maintenance/registry.ts` (`caldav_sync`,
  `wakePolicy: "scheduled_only"`), running push phase then pull phase under its
  single claim, applying planned actions through the thin shell with checkpoints
  and `requestFollowUp` for large batches, and finishing every pass — success or
  failure — by writing the durable sync status.

Storage: four listing columns (`caldav_pending` integer revision,
`caldav_pushed_at`, `caldav_etag`, and for foreign rows `caldav_uid` +
`caldav_href` encrypted with a `caldav_uid_index` blind index), a
`caldav_deletes` queue table, a `caldav_reviews` table (listing id, kind, held
remote values encrypted, held etag, created), and the settings keys named above
(credentials, direction, namespace, ctag, settings revision, sync status,
policies).

## Adversarial review

The PR_WORKFLOW challenge questions, answered:

- **External success, local write fails?** Idempotent by identity — see the
  failure table. Re-PUT overwrites; re-DELETE 404s.
- **Callback replayed?** No callbacks exist; wakes replay by design and are
  no-ops via etag/ctag/pending guards.
- **Follow-up read fails after success?** Push never needs a follow-up read
  (etag arrives later via pull). Pull failing mid-pass leaves ctag stale, so the
  pass repeats.
- **Wrong resource id?** Pushed targets are derived from id + immutable
  namespace; foreign targets use the stored observed href. A foreign UID
  mismatch means "unknown UID" → policy-gated create, never an overwrite of the
  wrong row.
- **Two requests run together?** Concurrency table: one claim serializes the
  phases; revision-guarded clears and `pending = 0`-guarded applies cover
  operator writes; the settings revision covers concurrent saves.
- **Stale form/revision?** The pending counter is the revision for listing sync
  writes; the CalDAV settings revision is the revision for settings saves. A
  stale write fails its `WHERE` (or fails closed) and becomes a no-op.
- **User reloads after interruption?** All operator actions (save settings,
  disconnect, accept/keep-ours) are idempotent; sync state is server-side.
- **Same resource on another record?** One calendar per site and UID uniqueness
  per collection; a foreign UID maps to at most one listing via the unique blind
  index.
- **One queued item fails permanently?** Isolated per item, surfaced in the
  durable sync status, never blocks the batch.
- **What does the operator see in unfinished states?** The settings page reads
  the durable sync status: connection state, per-phase last result, sanitized
  error, and counts; listings pages banner `needs_review` rows for owners and
  managers.

Review round 1 (Codex, PR #2064) forced these revisions, all reflected above:
push and pull merged into one serialized task (stale-REPORT interleaving
eliminated); deletion now requires a per-resource 404, never windowed absence;
the UID namespace is minted and stored, not derived from the mutable domain;
foreign hrefs are stored because UID ≠ address; pending is defined out of
pull-only mode (which froze edited listings forever); updates are GET-patch-PUT
so unmodeled calendar properties survive; the date-removal branch got its
revision guard; calendar-change and push-off transitions are defined; reviews
are resolved only explicitly and are visible to managers; dismissal stores the
held etag and re-asserts local state; all-day and floating times are specified;
sync status is durable; settings saves are revision-guarded; convergence is
promised per batch, not per wake; and the dormant connect-only slice was merged
into the push slice.

## Vertical pull requests

Each slice is a complete behavior, independently green and useful; each includes
the tests proving its rows and deletes any path it replaces.

1. **Connect and push.** Settings section (owner-only) with live verification
   and calendar discovery, namespace minting, pending revision + pushed_at +
   delete-queue migration, `vevent.ts` build/patch side (deduped with
   `feeds.ts`), the `caldav_sync` task's push phase, durable sync status. Value:
   an operator connects and their real calendar mirrors listings — create, edit,
   delete — the same day the PR merges. Budget: ~800 source lines; task budget
   ~4 db + ~12 external per wake (chunked, follow-up for more).
2. **Pull updates.** ctag fast path, REPORT, `vevent.ts` parse side,
   `sync-plan.ts` inbound arms, guarded applies, review rows + banner UI +
   accept/keep-ours actions. Value: calendar edits flow back safely. Budget:
   ~550 source lines; ~2 external + bounded db per wake on top of push.
3. **Remote create and delete policies.** The two owner choices, 404
   confirmation, their plan arms and notices. Value: full two-way parity with
   eventschedule, minus its unsafe corners. Budget: ~300 source lines.

Slices 1→2→3 are natural stack layers (`gh stack`) if reviewed together.

## Tests that prove the contract

- **Pure unit (mirror-located)**: `vevent` build/parse/patch round-trips
  including escaping, TZID→UTC, floating→site-timezone, all-day and
  RRULE/no-UID/no-DTSTART skips, and property-preservation (a VALARM survives a
  patch byte-for-byte); `multistatus` parsing against fixtures shaped like
  Radicale, Nextcloud, and Fastmail responses plus hostile/oversized input;
  `sync-plan` table-driven cases for every commands-table row, including
  pending-precedence, pull-only semantics, deletion candidacy, and the
  equal-fields store-etag-only rule. These carry the mutation gate.
- **Integration (test db + stubbed `fetch`)**: push idempotency (crash after
  PUT, re-run, exactly one remote resource); revision races (edit between read
  and clear, date restored during date-removal); patch-PUT preserving foreign
  properties; pull applies with `pending = 0` guard; ctag stored only after a
  clean pass; deletion requires the 404 probe; review accept / keep-ours flows
  including etag storage; settings-revision stale save fails closed; per-item
  failure isolation; subrequest budget counting; 401 surfacing via durable
  status.
- **Regression discipline**: each behavior lands with its failing-first test per
  AGENTS.md.
- **Cucumber journey**: connect → listing appears in (stubbed) calendar → remote
  edit pulls back → booking-bearing listing change is held and resolved from the
  review banner.

## Questions for approval

1. **Convergence pacing**: a bounded batch per 15-minute wake means a first
   connect on a site with, say, 100 dated listings takes a few hours to fully
   mirror. Acceptable, or do you want a bigger per-wake batch / best-effort
   inline push on listing writes as a later enhancement?
2. **Slice 3 in v1?** Remote-created events and deletion policies could ship
   later; defaults (`ignore`/`ignore`) make slices 1–2 complete without them.
3. **Review-hold bar**: held when the listing **has attendees** — or should any
   _active_ listing's inbound date change be held too?
4. **REPORT window**: proposing −30 days … +400 days (a named constant). Events
   outside it are invisible to pull; deletion candidacy is limited to it, and
   confirmed only by a direct 404. OK?
5. **Budgets**: the revised source-line estimates above — acceptable?
