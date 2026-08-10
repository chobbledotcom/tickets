# CalDAV two-way sync — behavior contract

Status: **draft, awaiting human approval** (PR_WORKFLOW.md step 6). No tests or
implementation exist yet. This contract was researched against
[eventschedule](https://github.com/eventschedule/eventschedule)'s CalDAV
implementation (`app/Services/CalDAVService.php` and friends); where this design
copies or deliberately departs from theirs, the text says so. Revision 3
incorporates two adversarial review rounds (Codex, PR #2064) — the
[Adversarial review](#adversarial-review) section records what changed in each.

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

| Fact                                             | Why it may be trusted                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server URL, username, app password               | Operator-entered, verified by a live PROPFIND before saving. Stored as encrypted settings. Expected, not proof of later success.                                                                                                                                                                                                                                     |
| Calendar URL                                     | Chosen from a server-provided discovery list (or pasted), re-verified at save. Expected fact.                                                                                                                                                                                                                                                                        |
| The UID namespace                                | A random token minted when the calendar destination is first chosen (or changed) and stored in settings. Immutable while that destination is in use, so pushed identities survive custom-domain changes **and** disconnect/reconnect to the same calendar. Doubles as the connection **generation**: every task state write requires the generation it started with. |
| Pushed event identity `listing-{id}@{namespace}` | Deterministic — derived from the listing id and the stored namespace. Never guessed; the href we PUT to is the one we derived.                                                                                                                                                                                                                                       |
| A foreign event's href + UID                     | Observed facts from a REPORT. The href, not the UID, addresses the resource (RFC 4791 does not promise `{uid}.ics`), so both are stored for foreign rows, and **a stored foreign href always outranks a derived one**.                                                                                                                                               |
| A server-provided href                           | Untrusted until checked: it must resolve inside the verified origins (the saved server URL's origin or the saved calendar URL's origin). Any other origin is rejected loudly — credentials never travel anywhere the operator didn't verify.                                                                                                                         |
| A listing row and its `caldav_pending` rev       | Written transactionally by `listingsTable`; the pending counter is authoritative for "local changes not yet pushed".                                                                                                                                                                                                                                                 |
| A stored per-listing etag                        | Observed fact from a REPORT/PROPFIND response. Proves what version we last saw, not what the server holds now.                                                                                                                                                                                                                                                       |
| The collection ctag / sync-token                 | Observed fact. A **non-null** stored token equal to a **non-null** observed token proves nothing changed since the last fully successful pull pass — null never equals null.                                                                                                                                                                                         |
| A REPORT response body                           | Untrusted external input from the configured server. Parsed strictly at the boundary; malformed items fail loudly per item.                                                                                                                                                                                                                                          |
| An HTTP 2xx on PUT                               | Proves the server accepted **that** write. Does not prove a later read succeeds, and may not include an ETag header.                                                                                                                                                                                                                                                 |
| An HTTP 412 on a conditional PUT                 | Proves the resource changed under us — the write did not happen, and must be replanned from a fresh read.                                                                                                                                                                                                                                                            |
| An HTTP 404 on GET/DELETE of a resource          | Proves the resource is gone — the only fact deletion detection may act on.                                                                                                                                                                                                                                                                                           |

Never substitute an expected fact for a missing observed fact: a listing is
"synced" only once a pull has observed its etag, and an absence from a windowed
REPORT is never treated as a deletion (see the commands table).

## Valid states

Site-level connection state (settings-backed):

```typescript
type CalDavConnection =
  | { kind: "disconnected" } // may retain dormant identity state, see below
  | {
    kind: "configured";
    direction: "push" | "pull" | "both";
    // Credentials verified by a live test at save time.
    serverUrl: string;
    calendarUrl: string;
    // Minted when this calendar was first chosen; never changes while it is
    // in use. Also the generation every task state write is guarded by.
    uidNamespace: string;
    // Null until the first fully successful pull pass.
    ctag: string | null;
    // UTC day of the last full REPORT; the ctag fast path is only valid on
    // the same day, so the moving time window cannot hide future events.
    lastReportDay: string | null;
  };
```

Per-listing sync state, derived from the sync columns (`caldav_pending` integer
revision counter, `caldav_pushed_at`, `caldav_etag`, foreign
`caldav_uid`/`caldav_href`, and a `caldav_reviews` row):

| State                | Facts required                             | Meaning                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsynced`           | pending = 0, pushed_at null, etag null     | No remote copy expected (sync off, or listing has no date).                                                                                                                                                                                                 |
| `pending_push`       | pending > 0 (push enabled)                 | Local changes not yet on the calendar. Inbound updates are skipped while pending.                                                                                                                                                                           |
| `pushed_unconfirmed` | pending = 0, pushed_at non-null, etag null | On the calendar (we PUT it), but no pull has observed its etag yet. Push **sets pushed_at and nulls etag** — a pre-PUT etag is stale by definition.                                                                                                         |
| `synced`             | pending = 0, etag non-null                 | Both sides aligned as of the etag we hold.                                                                                                                                                                                                                  |
| `needs_review`       | review row exists                          | An inbound change was held for a human. **A review freezes the row both ways**: pull skips it (already held) and push skips it too, so an ordinary edit cannot silently overwrite the held remote change — only the explicit resolution actions unblock it. |

Pull-created listings additionally carry the foreign identity (`caldav_uid` and
`caldav_href`, both encrypted, with a `caldav_uid_index` blind HMAC column for
lookups — the same pattern as listing slugs). A row with a foreign href is
**always addressed by that href**, whether or not it has ever been pushed;
derived identities apply only to rows without one. An unavailable read is not
"unchanged"; a missing etag is not an empty etag.

The pending counter is **push bookkeeping and exists only while push is
enabled**. In pull-only mode listing writes do not bump it, and both switching
push off and disconnecting zero every counter (a non-zero counter with no push
phase to consume it would freeze the row out of pull forever). The pull-only
conflict rule is that the calendar wins for plain listings — the operator chose
that direction — while the review holds still protect booking-bearing listings.

## Commands and events

| Starting state                                                                       | Command or event                                                         | Required result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disconnected                                                                         | Owner saves settings (live test passes)                                  | configured. Same calendar URL as the previous connection → dormant identity state (namespace, etags, pushed_at, foreign mappings, delete queue) is reused, so nothing is duplicated. A different (or first) calendar URL → identity state and the delete queue are cleared and a new namespace minted, atomically. If direction includes push, every dated listing gets pending bumped. The final write requires the CalDAV settings revision the form rendered with — a stale save fails closed with "settings changed, reload".                                                                                                                                                                                                                                                                       |
| disconnected                                                                         | Owner saves settings (live test fails)                                   | Nothing stored; the error is shown. No partial credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| configured                                                                           | Owner changes server URL or calendar URL                                 | The same atomic transition as connect-with-different-calendar: collection observations (ctag, etags, pushed_at), foreign mappings, review rows, **and queued delete jobs** cleared — a queued href must never be fired at a different destination — new namespace minted, pending bumped on all dated listings when push is enabled. Events on the old calendar stay there (documented).                                                                                                                                                                                                                                                                                                                                                                                                                |
| configured                                                                           | Owner switches push on (from off/pull)                                   | Pending bumped on all dated listings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| configured                                                                           | Owner switches push off                                                  | All pending counters zeroed — they mean "awaiting push" and nothing would consume them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| configured                                                                           | Owner disconnects                                                        | Credentials and direction cleared; **pending counters zeroed** (same invariant as push-off); review rows cleared (an open review never stored its held etag, so a surviving difference is re-detected and re-held on reconnect). Namespace, etags, pushed_at stamps, foreign mappings, and the delete queue stay **dormant** so reconnecting to the same calendar duplicates nothing. Remote events stay on the calendar (documented).                                                                                                                                                                                                                                                                                                                                                                  |
| any, push enabled                                                                    | Listing created/updated via `listingsTable`                              | `caldav_pending = caldav_pending + 1` in the same statement. No external call. (Inbound applies are the one exception — sync bookkeeping, not an operator change, so they never bump pending.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| any                                                                                  | Listing deleted                                                          | While push is enabled: a `caldav_deletes` queue row (the row's stored foreign href, else its derived href) written in the same batch as the delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| configured                                                                           | `caldav_sync` wake                                                       | One claimed task, two phases in order: **push phase** then **pull phase** (each active only if the direction includes it). Serializing them in one claim is what makes the interleavings below impossible. The task reads the connection generation (namespace) at start; **every state write it makes is conditional on that generation still being stored**, so a settings change mid-pass makes the leased worker's writes no-ops instead of corrupting the new connection.                                                                                                                                                                                                                                                                                                                          |
| push phase                                                                           | Pending dated listing with an open review                                | Skip — a frozen conflict is not pushed over. The listing edit page's review banner says changes wait until the conflict is resolved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| push phase                                                                           | Pending dated listing with a foreign href                                | GET the stored href, patch, conditional PUT — the foreign-href path applies to every foreign row, pushed before or not; the derived identity is never used where a foreign mapping exists (using it would create a second resource).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| push phase                                                                           | Pending dated listing, no remote copy yet                                | Build VEVENT, plain PUT to the derived href (unconditional, so a crash-replay overwrites its own earlier attempt instead of failing), then set pushed_at, null the etag, and clear pending — all guarded by `WHERE caldav_pending = readValue`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| push phase                                                                           | Pending dated listing, pushed before                                     | GET the current resource; patch it — replace only the fields we own (SUMMARY, DTSTART, DESCRIPTION, LOCATION, DTSTAMP, LAST-MODIFIED), **recompute DTEND from the observed end-minus-start duration so the event moves as a whole** (no end observed → none written), and preserve every other property and sub-component verbatim (VALARM, ATTENDEE, categories…). PUT back **with `If-Match` on the GET's etag**: a 412 means the calendar changed under us — the row stays pending and the next wake re-reads and re-patches, so a concurrent calendar edit is never overwritten from a stale read. A 404 on the GET means it vanished remotely: fall back to a create-PUT. Then the same guarded clear.                                                                                             |
| push phase                                                                           | Pending listing whose date was removed                                   | Queue a delete and null etag/pushed_at, guarded by `WHERE caldav_pending = readValue AND date = ''` — a date restored mid-task survives, stays pending, and repushes next wake.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| push phase                                                                           | Delete queue rows                                                        | DELETE each href; 404 = success; remove the row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| pull phase                                                                           | Stored and observed ctag both non-null and equal, last full REPORT today | Done — one external call for the whole phase. The fast path needs all three: a token-less server (null observed) always REPORTs, and a new UTC day always REPORTs even on an unchanged ctag, because the query window moves with time and an unchanged collection can still have events newly inside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| pull phase                                                                           | Otherwise                                                                | REPORT (etag + calendar data, bounded time window), apply the per-VEVENT rules below, then store the new ctag and the report day **only after a fully error-free pass**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| pull: VEVENT, known listing, same etag                                               | —                                                                        | Skip (fast path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| pull: VEVENT, known listing, changed etag                                            | —                                                                        | pending > 0 or review open → skip. Listing has attendees and date/name changed → write a review row, touch nothing else. Parsed fields equal to local values → store etag only (no listing write, no churn). Otherwise apply the guarded update (name from SUMMARY, date from DTSTART; description/location only when non-empty — an emptied remote field never blanks a local one) in one transaction whose write requires **both** `caldav_pending = 0` **and** the no-attendees condition still holding at write time (the trigger-maintained `booked_quantity` makes that a single-statement check) — a booking that lands between plan and apply flips the outcome to a review row instead. Never bumps pending; stores the etag.                                                                  |
| pull: VEVENT, unknown UID                                                            | —                                                                        | Per owner policy: ignore (default), or create an **inactive** listing (name, date, description, location; no prices) storing the foreign UID, href, and etag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| pull: VEVENT with RRULE / RECURRENCE-ID / VALUE=DATE (all-day) / no UID / no DTSTART | —                                                                        | Skip; count and surface in sync status. (eventschedule flattens recurring events to one instance — we refuse instead of corrupting. All-day events don't map onto a timed listing.) A **floating** DTSTART — no TZID, no Z — is interpreted in the site's configured timezone, not skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| pull: previously-synced listing absent from REPORT                                   | —                                                                        | Absence alone proves nothing (the event may have been moved outside the window). Candidates — etag non-null, pending = 0, no open review, local date inside the window, bounded per pass — are confirmed by a **direct GET of the resource**: 404 → apply the owner's deletion policy (ignore, or deactivate + review row; never hard-delete; bookings untouched); 200 → treat its body as an ordinary inbound update.                                                                                                                                                                                                                                                                                                                                                                                  |
| needs_review                                                                         | A human resolves the review                                              | Explicit action on the review surface, never a silent side effect. The form carries the held etag it rendered, and resolution **fails closed if the stored review no longer matches** ("this conflict changed, reload") — a manager can never apply or dismiss a version of the conflict they did not see. **Accept** applies the held values through the normal listing edit path; **keep ours** stores the held etag (so the same change is not re-held) and bumps pending when push is enabled, re-asserting local state to the calendar. In pull-only mode "keep ours" stores the etag and the divergence is documented on the review surface. An ordinary listing edit does **not** clear a review row — the row's banner on the edit page shows the held remote values until someone resolves it. |

Every command has one authoritative implementation: the pure planner
(`sync-plan.ts`, below) decides; thin IO applies.

## Failure table

| Work completed                          | Failure                         | Required result                                                                                                                                           | Retry owner        |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Nothing                                 | Save-settings live test fails   | No settings stored; operator sees the error.                                                                                                              | Operator           |
| Listing write committed                 | (no external work in-request)   | Pending counter is durable; calendar catches up on a later wake.                                                                                          | `caldav_sync` task |
| GET-before-update succeeded             | PUT fails                       | Row stays pending (clear never ran); retried next wake.                                                                                                   | `caldav_sync` task |
| Conditional PUT                         | 412 (resource changed)          | No write happened; row stays pending; next wake re-reads and re-patches from the fresh resource.                                                          | `caldav_sync` task |
| PUT succeeded                           | Pending-clear write fails       | Task fails; next wake re-runs the same derived-identity PUT — an idempotent overwrite, never a duplicate.                                                 | `caldav_sync` task |
| Some PUTs done                          | A later PUT fails               | Completed rows stay cleared; the failed row stays pending; task reports failure, retries at `failureRetryIntervalMs`. One bad row never blocks the rest.  | `caldav_sync` task |
| REPORT fetched, some rows applied       | A later row fails               | Applied rows keep their new etags (committed per row); ctag **not** advanced, so the next wake reprocesses — cheap, because unchanged rows skip via etag. | `caldav_sync` task |
| Deletion-candidate GET                  | Network error                   | Not 404 — no deletion action; candidate re-checked next wake.                                                                                             | `caldav_sync` task |
| DELETE sent                             | 404                             | Success; queue row removed.                                                                                                                               | —                  |
| Mid-pass                                | Owner changes calendar settings | The leased worker's remaining state writes fail their generation guard and become no-ops; the pass ends without corrupting the new connection.            | Next wake          |
| Anything                                | 401/403 (credentials revoked)   | Task failure every wake; the durable sync status records it so the settings page shows it.                                                                | Operator           |
| Deactivate-on-remote-delete write fails | —                               | Task failure; the resource still GETs 404 next wake, so it is re-detected and retried.                                                                    | `caldav_sync` task |

Every task pass ends by writing a **durable sync status** (a settings key:
per-phase timestamp, ok/failed, sanitized bounded error summary, and counts —
pushed, applied, held, skipped by reason). That write is inside the task's
database budget and is itself generation-guarded; without it a scheduled-request
failure would be invisible to the operator, who only ever sees the settings
page.

The external-success/local-failure gap is closed by identity, not bookkeeping:
because the PUT target is derived (or stored, for foreign rows), losing the
local write after a remote success costs one redundant idempotent PUT, nothing
more. (eventschedule mints a random UUID per attempt; a crash between PUT and
storing it duplicates the event on the calendar. Ours cannot.)

## Retry and replay table

| Question                         | Push phase                                                                                                                                                              | Pull phase                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Stable identity                  | `listing-{id}@{namespace}` and its derived href; stored href for foreign rows.                                                                                          | Remote href + UID; per-listing etag; collection ctag + report day. |
| Exact replay returns             | Create: same-bytes PUT overwrites in place. Update: `If-Match` either succeeds identically or 412s into a clean retry.                                                  | Same etag → skip; same missing UID → same policy decision.         |
| Who retries after interruption   | Next scheduled wake (pending rows persist).                                                                                                                             | Next scheduled wake (ctag only stored after a clean pass).         |
| What stops two workers           | One maintenance claim covers both phases (`claimNextMaintenanceTask`) — one runner, one order; generation guards stop a stale leased worker crossing a settings change. | Same claim, same guards.                                           |
| Permanent failures               | A PUT the server always rejects: row stays pending, surfaced in sync status; blocks nothing.                                                                            | Malformed VEVENT: skipped and counted every pass; blocks nothing.  |
| Can one failed item block others | No — per-item isolation; the task still reports failure so retry happens.                                                                                               | No — same.                                                         |

## Concurrency table

| Operation A                         | Operation B                            | Required result                                                             | Protection                                                                                                                                                               |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Push PUTs listing content           | Operator edits the same listing        | The newer edit is pushed on a later wake, never lost.                       | Pending is a **revision counter**: the edit bumps it; every push-side write clears with `WHERE caldav_pending = readValue`, so a bump after the read survives the clear. |
| Push patches a remote event         | Calendar user edits the same event     | The calendar user's concurrent edit is never overwritten from a stale read. | `If-Match` on the update PUT; 412 → replan from a fresh GET next wake.                                                                                                   |
| Date-removal queues a remote delete | Operator restores the date             | No stale delete; the listing repushes.                                      | The queue insert and etag/pushed_at clear run `WHERE caldav_pending = readValue AND date = ''`.                                                                          |
| Pull applies an inbound update      | Operator edits the same listing        | The operator's edit wins; remote is overwritten on next push.               | Inbound apply runs `WHERE caldav_pending = 0`; a concurrent bump makes it a no-op skip.                                                                                  |
| Pull applies an inbound update      | A booking commits on that listing      | The change is held for review, not applied to a booked listing.             | The apply's write re-checks the no-attendees condition (`booked_quantity`) in the same statement; failure flips to a review row.                                         |
| Manager resolves a review           | Pull replaces the held change          | The manager never applies or dismisses a conflict version they didn't see.  | Resolution carries the rendered held etag and fails closed on mismatch.                                                                                                  |
| Owner changes calendar settings     | A leased `caldav_sync` pass is running | The old-destination worker cannot write into the new connection state.      | Every task state write is conditional on the generation (namespace) the pass started with.                                                                               |
| Push phase                          | Pull phase                             | Pull always observes the world push left behind.                            | Both phases run inside **one claimed task**, push first; claims serialize wakes.                                                                                         |
| Two scheduled wakes overlap         | —                                      | One runner.                                                                 | Maintenance claim rows.                                                                                                                                                  |
| Pull runs before first push         | New listing pending, absent remotely   | Not treated as remotely deleted.                                            | Deletion candidacy requires etag non-null, pending = 0, no open review — and is confirmed only by a direct 404.                                                          |
| Two owners save CalDAV settings     | —                                      | The later-rendered form wins; the stale one fails closed.                   | The save carries the CalDAV settings revision it rendered with; the final write requires it to still match.                                                              |

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
   actions. While the review is open the listing is frozen in both directions —
   pull holds, and push skips it too — so neither an ordinary edit nor the sync
   itself can settle the conflict as a side effect.

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
  basic-auth header. **Every URL the client touches — including every
  server-provided href from discovery or multistatus responses — must resolve
  inside the verified origins**: the saved server URL's origin or the saved
  calendar URL's origin, both of which the operator entered and a live test
  verified. An href on any other origin is rejected loudly (discovery that
  genuinely lives elsewhere fails with a message telling the operator to enter
  the calendar URL directly, which brings that origin into the verified set).
  Credentials are therefore never sent anywhere the operator didn't name. Every
  request counts against the task's declared external budget.
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
  bookings or money, and cannot direct requests — or credentials — outside the
  verified origins.

## Shared contract (design)

One new module family, `src/shared/caldav/`, split pure-core/thin-shell:

- `vevent.ts` — pure. Build a VEVENT from a listing; parse a VEVENT into a
  typed, valibot-validated record (UID, SUMMARY, DTSTART with TZID→UTC and
  floating→site-timezone, DTEND, DESCRIPTION, LOCATION, RRULE/all-day flags);
  and **patch** an existing raw VEVENT — replace only the fields we own,
  recompute DTEND from the observed duration so the event moves whole, and
  round-trip every other property and sub-component byte-preserved, so a push
  can never strip alarms or attendees from a calendar event. Absorbs and shares
  the ICS escaping/date helpers currently in `src/features/feeds.ts` — one ICS
  vocabulary, no parallel implementation.
- `multistatus.ts` — pure. Parse PROPFIND/REPORT multistatus XML into typed rows
  (href, etag, calendar-data, ctag, displayname, resourcetype). Strict and
  bounded; no regex-scraping of XML (eventschedule's approach).
- `client.ts` — thin IO. `propfind` / `report` / `get` / `put` (plain and
  `If-Match`-conditional) / `delete` over `fetch` with basic auth, the
  verified-origin and outbound guards above, and subrequest counting. Also
  calendar discovery (principal → home set → calendar list) for the settings UI.
- `sync-plan.ts` — pure, the heart.
  `(localRows, remoteRows, policies) →
  SyncAction[]` where `SyncAction` is an
  exhaustive discriminated union (`putNew`, `patchExisting`, `deleteRemote`,
  `confirmDeletion`, `applyUpdate`, `storeEtagOnly`, `holdForReview`,
  `createInactive`, `deactivate`, `skip` with a typed reason). Every rule in the
  commands table lives here — foreign-href precedence, review freezes, fast-path
  validity — unit-tested and mutation-tested without IO.
- One entry in `src/shared/maintenance/registry.ts` (`caldav_sync`,
  `wakePolicy: "scheduled_only"`), running push phase then pull phase under its
  single claim, applying planned actions through the thin shell with checkpoints
  and `requestFollowUp` for large batches, guarding every state write with the
  connection generation, and finishing every pass — success or failure — by
  writing the durable sync status.

Storage: five listing columns (`caldav_pending` integer revision,
`caldav_pushed_at`, `caldav_etag`, and `caldav_uid` + `caldav_href` encrypted
with a `caldav_uid_index` blind index on foreign rows), a `caldav_deletes` queue
table, a `caldav_reviews` table (listing id, kind, held remote values encrypted,
held etag, created), and the settings keys named above (credentials, direction,
namespace, ctag, last-report day, settings revision, sync status, policies).

## Adversarial review

The PR_WORKFLOW challenge questions, answered:

- **External success, local write fails?** Idempotent by identity — see the
  failure table. Re-PUT overwrites (or 412s into a clean retry); re-DELETE 404s.
- **Callback replayed?** No callbacks exist; wakes replay by design and are
  no-ops via etag/ctag/pending guards.
- **Follow-up read fails after success?** Push never needs a follow-up read
  (etag arrives later via pull). Pull failing mid-pass leaves ctag stale, so the
  pass repeats.
- **Wrong resource id?** Foreign rows are always addressed by their stored
  observed href; rows without one use the derived id + immutable namespace. A
  foreign UID mismatch means "unknown UID" → policy-gated create, never an
  overwrite of the wrong row.
- **Two requests run together?** Concurrency table: one claim serializes the
  phases; revision-guarded clears, `pending = 0` + attendee-recheck applies,
  `If-Match` PUTs, generation-guarded state writes, and the settings revision
  cover the rest.
- **Stale form/revision?** The pending counter guards listing sync writes; the
  settings revision guards settings saves; the held etag guards review
  resolutions; the generation guards a leased worker. Every stale write fails
  its condition and becomes a no-op or a fail-closed error.
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

**Review round 1** (Codex, commit `0e7662e`) forced: push and pull merged into
one serialized task; deletion requires a per-resource 404; the UID namespace is
minted, not derived from the mutable domain; foreign hrefs are stored; pending
defined out of pull-only mode; GET-patch-PUT preservation; the date-removal
revision guard; calendar-change and push-off transitions; manager-visible
explicit-only reviews; durable sync status; revision-guarded settings saves;
honest convergence wording; the dormant connect-only slice merged away.

**Review round 2** (Codex, commit `dbf7b45`) forced: an open review now freezes
push as well as pull; disconnect zeroes pending and keeps identity state dormant
so a same-calendar reconnect duplicates nothing; update PUTs are
`If-Match`-conditional with 412-replan; the delete queue is cleared atomically
with a destination change; foreign hrefs outrank the pushed_at branch; the ctag
fast path requires a non-null token **and** a same-day full REPORT (the moving
window can hide events on an unchanged ctag); inbound applies re-check the
attendee condition at write time; review resolutions carry and verify the held
etag; server-provided hrefs are confined to the verified origins; patches move
DTEND with DTSTART by preserving the observed duration; and a leased pass is
generation-guarded across settings changes.

## Vertical pull requests

Each slice is a complete behavior, independently green and useful; each includes
the tests proving its rows and deletes any path it replaces.

1. **Connect and push.** Settings section (owner-only) with live verification
   and calendar discovery, namespace minting and the connect/change/disconnect
   transitions, pending revision + pushed_at + delete-queue migration,
   `vevent.ts` build/patch side (deduped with `feeds.ts`), the `caldav_sync`
   task's push phase with conditional PUTs and generation guards, durable sync
   status. Value: an operator connects and their real calendar mirrors listings
   — create, edit, delete — the same day the PR merges. Budget: ~850 source
   lines; task budget ~4 db + ~12 external per wake (chunked, follow-up for
   more).
2. **Pull updates.** ctag/report-day fast path, REPORT, `vevent.ts` parse side,
   `sync-plan.ts` inbound arms, guarded applies with the attendee recheck,
   review rows + banner UI + etag-verified accept/keep-ours actions. Value:
   calendar edits flow back safely. Budget: ~600 source lines; ~2 external +
   bounded db per wake on top of push.
3. **Remote create and delete policies.** The two owner choices, 404
   confirmation, their plan arms and their notices. Value: full two-way parity
   with eventschedule, minus its unsafe corners. Budget: ~300 source lines.

Slices 1→2→3 are natural stack layers (`gh stack`) if reviewed together.

## Tests that prove the contract

- **Pure unit (mirror-located)**: `vevent` build/parse/patch round-trips
  including escaping, TZID→UTC, floating→site-timezone, all-day and
  RRULE/no-UID/no-DTSTART skips, DTEND moving with DTSTART by observed duration,
  and property preservation (a VALARM survives a patch byte-for-byte);
  `multistatus` parsing against fixtures shaped like Radicale, Nextcloud, and
  Fastmail responses plus hostile/oversized input and out-of-origin hrefs
  (rejected); `sync-plan` table-driven cases for every commands-table row —
  pending precedence, review freezes both ways, foreign-href precedence over
  pushed_at, pull-only semantics, deletion candidacy, fast-path validity (null
  tokens, stale report day), and the equal-fields store-etag-only rule. These
  carry the mutation gate.
- **Integration (test db + stubbed `fetch`)**: push idempotency (crash after
  PUT, re-run, exactly one remote resource); revision races (edit between read
  and clear, date restored during date-removal); 412 on a conditional PUT leaves
  the row pending and re-patches next wake; imported event edited locally PUTs
  to its stored href (no duplicate); pull applies with the `pending = 0` +
  attendee-recheck guard (a booking mid-apply produces a review, not an applied
  change); ctag stored only after a clean pass; a token-less server REPORTs
  every wake; deletion requires the 404 probe; review accept / keep-ours flows
  including held-etag verification; disconnect/reconnect to the same calendar
  reuses identities (no duplicate events or listings); destination change clears
  the delete queue; a generation-guarded worker's writes no-op after a mid-pass
  settings change; settings-revision stale save fails closed; per-item failure
  isolation; subrequest budget counting; 401 surfacing via durable status.
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
   outside it are invisible to pull; deletion candidacy is limited to it and
   confirmed only by a direct 404; the daily forced REPORT keeps the moving
   window honest. OK?
5. **Budgets**: the revised source-line estimates above — acceptable?
