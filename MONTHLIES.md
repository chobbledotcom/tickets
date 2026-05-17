# Monthly renewals for built sites

## Goal

Customers who sign up online and get a built site delivered should be able
to keep that site running by paying a monthly fee. Each site has its own
private "renewal" page on the host instance; visiting it and paying for `N`
months extends the site's read-only deadline by `N` months. When the
deadline passes, the built site flips itself into read-only mode (the
existing `READ_ONLY` machinery) until the customer renews.

This is two systems glued together:

1. The **host** instance owns a renewal event per built site, takes the
   payment, and writes the new deadline back onto the built site's edge
   script as a secret.
2. The **built site** treats a new `READ_ONLY_FROM` secret (an ISO
   timestamp) as the source of truth for its own read-only mode. The
   existing `READ_ONLY=true` boolean still works as an override.

The two halves are coupled by:

- `built_sites.bunnyScriptId` (already stored) — lets the host call the
  Bunny CDN API to update secrets on the customer's edge script.
- A `RENEWAL_URL` secret on the built site — points at the host's per-site
  renewal event so the built site can deep-link the customer to renew.

## Codebase findings (May 2026)

- **Built sites table** (`src/shared/db/built-sites.ts`): rows already hold
  `bunnyScriptId`, `bunnyUrl`, `dbUrl`, `dbToken` (encrypted blob), plus
  the `assigned_attendee_id` / `assigned_event_id` set by
  `assignBuiltSite` after a purchase webhook fires. The blob has a
  versioned shape (`v: 1`) — easy to extend.
- **Provisioning entry point** (`src/shared/site-assignment.ts`):
  `assignAndNotifyBuiltSites` runs in `addPendingWork` after every
  registration webhook (`src/shared/webhook.ts` line 173). When the
  purchased event has `assign_built_site=1`, it pulls an available built
  site (or calls `buildSiteForAssignment` to make one), assigns it,
  and emails the URL.
- **Site builder** (`src/shared/builder.ts`): `buildSite` creates the
  edge script, configures secrets (`DB_URL`, `DB_TOKEN`,
  `DB_ENCRYPTION_KEY`, `BUNNY_SCRIPT_ID`, plus copied `HOST_SECRET_KEYS`),
  then publishes. Secrets are pushed via
  `bunnyCdnApi.setEdgeScriptSecret(scriptId, name, value)`
  (`src/shared/bunny-cdn.ts:490`). The function returns
  `{ scriptId, defaultHostname, dbUrl, dbToken }` so the assignment flow
  already knows the script ID at the moment of provisioning.
- **Read-only mode** (`src/shared/env.ts:36`):
  `isReadOnly()` is a single function that reads `READ_ONLY` from
  `getEnv`. It's called from `readOnlyGuard` in `src/features/index.ts`
  and a dozen template files. Centralising the check is easy — there's
  exactly one source of truth.
- **Events** are the natural carrier for a renewal: they already have a
  unique slug + `slug_index` blind index (`src/shared/db/events.ts`),
  a payment flow with Stripe/Square, a webhook pipeline, `purchase_only`
  (no ticket sent), `hidden` (excluded from public listings, sets
  `x-robots-noindex`), `unit_price`, `max_quantity`, `can_pay_more`,
  `max_price`. A renewal is conceptually `purchase_only=1, hidden=1,
  assign_built_site=0`, with quantity = months.
- **Webhook hook point** for "site bought": currently the only post-
  payment side-effect for built-site events is `assignAndNotifyBuiltSites`
  in `src/shared/webhook.ts`. We need a parallel hook that runs when a
  *renewal* event is paid for, and updates the deadline on the linked
  site.
- **No subscription support** — the codebase has zero recurring billing
  primitives. This plan deliberately keeps everything as one-shot top-up
  payments; the customer chooses a quantity (= months) each time.

## Decisions

### Naming

- New env-var / secret on the built site: **`READ_ONLY_FROM`** — an ISO
  timestamp. The site is read-only iff `now >= READ_ONLY_FROM`. Keep
  `READ_ONLY=true` as an override (admin / host can force read-only
  regardless of date).
- New secret on the built site: **`RENEWAL_URL`** — absolute URL to the
  per-site renewal event on the host instance.
- New events feature flag value: **`event_type = "renewal"`** is *not*
  used. Renewal events are regular `standard` events with
  `purchase_only=1, hidden=1` and a new dedicated link column (below).
  That keeps the booking flow unchanged.

### Schema additions

- `events.renewal_for_site_id INTEGER DEFAULT NULL` — when set, this
  event is the renewal page for that built site. Used to:
  - Locate the site on payment finalisation.
  - Guard the event so it can never be mass-listed, duplicated, or
    edited in a way that breaks the link.
- `events.months_per_unit INTEGER NOT NULL DEFAULT 0` — for renewal
  events, **1 unit of `quantity` = this many months**. Default `1`
  (one month per quantity). The booking quantity selector then doubles
  as a "how many months?" selector. Default `0` for non-renewal events
  (unused).
- `built_sites.read_only_from TEXT NOT NULL DEFAULT ''` — host-side
  cache of the deadline currently set on the edge script. Avoids hitting
  the Bunny API to read it back, and gives us an audit-friendly value
  for the admin UI.
- `built_sites` blob `v: 2`: add `renewalEventId?: number` so we can
  rebuild the relationship from either side. Not strictly required (the
  events table already points at the site) but cheap and useful for
  display.

### Initial deadline on first sale

A new column **`events.initial_site_months INTEGER NOT NULL DEFAULT 0`**
on the source event. Admin-editable, **required to be > 0** when
`assign_built_site=1` — the form rejects `0` on save. Zero is allowed
on non-built-site events (column simply ignored). On assignment:

1. Compute `READ_ONLY_FROM = now() + initial_site_months months`.
   Push it to the built site's edge script as a secret.
2. Create a renewal event for **each** provisioned site (one event row
   per site, even when one checkout provisions multiple). Push that
   event's public URL to the edge script as `RENEWAL_URL`.

When `quantity > 1` on the selling event, each of the N sites gets its
own renewal event with its own slug. Each can be renewed independently.

### Coupling renewal events to sites

- **One renewal event per built site**, created at assignment time
  (the moment `assignBuiltSite` is called).
- Renewal event defaults at creation:
  - `name`: `"Renew <site name>"`
  - `slug`: auto-generated unique slug (existing `generateUniqueSlug`).
  - `hidden=1, purchase_only=1, assign_built_site=0`.
  - `unit_price = DEFAULT_MONTHLY_RENEWAL_PRICE` (env var; see below).
    Admin can edit per-event afterwards. The price lives **only on
    the renewal event row** — there is no per-source-event field and
    no inheritance from the selling event's `unit_price`.
  - `months_per_unit = 1`.
  - `max_quantity = 24` (cap, admin-tunable).
  - `can_pay_more=0`, `non_transferable=1`.
  - `renewal_for_site_id = <built_site.id>`.
- `RENEWAL_URL` resolves to the regular public event page
  (`https://<host>/<slug>`). No dedicated `/renew/...` route — the
  hidden+purchase-only event flow already does the right thing.
- The slug is not cryptographically secret. `hidden=1` keeps it off
  the public listing and sets `x-robots-noindex`, and the URL is only
  shared with the site owner via the `RENEWAL_URL` secret on the
  edge script. Default 5-char slug from `generateSlug` is fine.

### Renewal default price env var

- New env var **`DEFAULT_MONTHLY_RENEWAL_PRICE`** (integer pence /
  smallest currency unit, matching the existing `unit_price`
  convention).
- Used as the default `unit_price` for every newly-created renewal
  event. Admin can edit per-event afterwards.
- **Validation:** when `CAN_BUILD_SITES=true`, the renewal flow
  refuses to run if `DEFAULT_MONTHLY_RENEWAL_PRICE` is unset or
  non-positive. Checked at request time (edge has no startup phase) —
  specifically, `assignSitesForEntries` short-circuits with a logged
  + ntfy'd error before any DB write, so the host operator notices
  before customers do. Tested.

### Payment → deadline bump

When a renewal event payment succeeds:

1. The existing webhook pipeline calls `logAndNotifyRegistration`
   (`src/shared/webhook.ts:164`), which already iterates entries.
2. Add a new pending-work step alongside `assignAndNotifyBuiltSites`:
   `applyRenewalsForEntries(entries)`.
3. For each entry whose event has `renewal_for_site_id != null`:
   - Load the built site row.
   - Compute new deadline:
     `base = max(now(), site.read_only_from || now())`
     `new = addMonthsIso(base, attendee.quantity * event.months_per_unit)`
   - Push `READ_ONLY_FROM = new` to the site's edge script via
     `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId, "READ_ONLY_FROM", new)`.
   - **Only on success**, persist the new value to
     `built_sites.read_only_from`. On failure: log + ntfy, leave the
     host-side value at the previous (pre-renewal) date so the admin
     UI doesn't lie about a state that isn't on the edge. Recovery is
     the admin "Re-sync deadline" button (Phase 6) which replays the
     last successful host-side value to the edge — useful for
     transient Bunny failures, but the post-renewal failure path
     specifically needs a different recovery primitive: a "Push
     paid-for-but-not-applied months" admin action. See Phase 5.
   - **Refunds are explicitly out of scope for v1** — if a renewal
     gets refunded later, the customer keeps the time they paid for.
     Document as a known gap.
4. The renewal email is the existing post-payment email; no extra
   "thanks for renewing" template required for v1.

### Month arithmetic

`addMonthsIso(fromIso, months)` **clamps to the last day of the
target month**:

- `2026-01-31 + 1mo → 2026-02-28`
- `2024-01-31 + 1mo → 2024-02-29` (leap year)
- `2026-03-31 + 1mo → 2026-04-30`

The customer never gains or loses a day from month-boundary
arithmetic. Implementation: build with `Date.UTC(y, m + months,
min(originalDay, daysInMonth(y, m + months)))`.

### Payment → deadline bump

When a renewal event payment succeeds:

1. The existing webhook pipeline calls `logAndNotifyRegistration`
   (`src/shared/webhook.ts:164`), which already iterates entries.
2. Add a new pending-work step alongside `assignAndNotifyBuiltSites`:
   `applyRenewalsForEntries(entries)`.
3. For each entry whose event has `renewal_for_site_id != null`:
   - Load the built site row.
   - Compute new deadline:
     `base = max(now(), site.read_only_from || now())`
     `new = base + (attendee.quantity * event.months_per_unit) months`
   - Push `READ_ONLY_FROM = new` to the site's edge script via
     `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId, "READ_ONLY_FROM", new)`.
   - Persist the new value to `built_sites.read_only_from` so the admin
     UI / future renewals can read it back without API calls.
   - **Do not** re-publish the script (Bunny propagates secrets without
     republishing). Confirm this assumption — see open question.
4. The renewal email is the existing post-payment email; no extra
   "thanks for renewing" template required for v1.

### Built site read-only behaviour

- New helper in `src/shared/env.ts`:
  ```ts
  export const isReadOnly = (): boolean => {
    if (getEnv("READ_ONLY") === "true") return true;
    const cutoff = getEnv("READ_ONLY_FROM");
    if (!cutoff) return false;
    return Date.now() >= Date.parse(cutoff);
  };
  ```
- New helper `isReadOnlyWarning(): boolean` — true when the site is
  *not yet* read-only but is within `READ_ONLY_WARN_DAYS` days of the
  cutoff. Drives the pre-expiry banner.
- New env var **`READ_ONLY_WARN_DAYS`** (integer, default `14`) on
  the built site. Controls how early the warning banner appears.
- Banners deep-link to `RENEWAL_URL` in **both states**:
  - Pre-expiry: "Your site expires on `<date>` — Renew now" CTA.
  - Post-expiry: "This site is in read-only mode — Renew now" CTA.
  If `RENEWAL_URL` is unset (legacy site), banner falls back to the
  current generic text with no link.
- Invalid `READ_ONLY_FROM` values (unparseable / non-ISO) → log via
  `ErrorCode.DATA_INVALID` and treat as "not set" (fail open: the site
  stays writable rather than locking the customer out due to a typo).
- `nowIso()` already exists for tests; keep this function pure of any
  global mutable date state.
- Existing `READ_ONLY=true` env-var path still works for forced
  read-only (admin debug, paused account, etc.).

### Admin surface

- `built_sites` admin index gains a column showing
  `read_only_from` (or "never set" / "expired N days ago"). Today the
  index is rendered by the CRUD adapter (`builtSitesCrudTable`) so this
  is a small template tweak.
- Per-site detail page gets:
  - A "Renewal event" link to the linked `renewal_for_site_id` event.
  - A manual **"Re-sync deadline"** button that re-pushes the host's
    stored `read_only_from` to the edge script. Primary recovery
    path for failed Bunny pushes.
  - A "Set deadline" form for support overrides (host operator only).
    Writes the host-side value and pushes to the edge script.
- Source events (the ones that *sell* sites, `assign_built_site=1`)
  get an `initial_site_months` field in the event form, **required
  to be > 0**. Form validation rejects `0` on save.
- Renewal events appear **mixed into the main admin events list**
  with a visual "Renewal" tag and the linked site name shown beside
  the event name. The events list query stays unchanged; the
  template branches on `renewal_for_site_id != null`. Their edit
  page hides/locks the `renewal_for_site_id`, `months_per_unit`,
  and `assign_built_site` fields (admin can still edit price, name,
  `max_quantity`, etc.).

## Non-goals

- Subscriptions / auto-renew. Customer renews manually each cycle.
- Pro-rating, refunds for unused months.
- Email reminders before expiry — phase 2 (cron-like ntfy / digest).
- A "self-renewal" page rendered by the built site itself; v1 just
  links out to the host's renewal event via `RENEWAL_URL`.
- Multi-currency renewal pricing (uses existing `settings.currency`).
- Renewal events showing up in any aggregate revenue admin report
  (treat them as opaque for now).

## Phases

Each phase is intended to be a shippable, typechecking, test-passing
state. Earlier phases default new fields to neutral values so existing
sites and events keep working unchanged.

---

### Phase 1 — Schema + types

**Files**

- `src/shared/db/migrations.ts`
  - Add to the `events` table columns:
    - `["renewal_for_site_id", "INTEGER DEFAULT NULL"]`
    - `["months_per_unit", "INTEGER NOT NULL DEFAULT 0"]`
    - `["initial_site_months", "INTEGER NOT NULL DEFAULT 0"]`
  - Add to the `built_sites` table columns:
    - `["read_only_from", "TEXT NOT NULL DEFAULT ''"]`
  - Bump `LATEST_UPDATE` to `"add monthly renewals to events + built_sites"`.
- `src/shared/types.ts` — extend `Event` with the three new fields.
- `src/shared/db/events.ts` — extend `rawEventsTable` schema with
  `renewal_for_site_id: col.withDefault<number | null>(() => null)`,
  `months_per_unit: col.withDefault(() => 0)`,
  `initial_site_months: col.withDefault(() => 0)`. Extend `EventInput`
  with the matching camelCase optionals.
- `src/shared/db/built-sites.ts` — extend `BuiltSiteRow`, `BuiltSite`,
  the schema, `rowToBuiltSite`, and the CRUD adapter to surface
  `readOnlyFrom: string`. Site-data blob (`SiteDataBlob`) bumps to
  `v: 2` and gains optional `renewalEventId?: number`.

**Tests**

- `test/lib/db.test.ts` — round-trip an event with the three new
  fields and a built_site with `read_only_from` set.

---

### Phase 2 — Built site read-only-from + warning banner

This is the customer-facing payoff: even with no renewal flow wired up,
a site with `READ_ONLY_FROM` set in the past becomes read-only on its
own, and one within `READ_ONLY_WARN_DAYS` days shows a pre-expiry
warning.

**Files**

- `src/shared/env.ts`
  - Replace `isReadOnly` body with the helper shown above
    (force-override + date-based cutoff).
  - Add `isReadOnlyWarning(): boolean` — true when `READ_ONLY_FROM`
    is set, in the future, and `now >= cutoff - READ_ONLY_WARN_DAYS`.
  - Add `getReadOnlyCutoffIso(): string | null` — exposes the parsed
    cutoff for banner copy / templates.
  - Add `getRenewalUrl(): string | null` — reads `RENEWAL_URL` secret.
  - Pure helpers (no env access) for the date math, to keep tests
    fast: `isReadOnlyFromCutoff(now, cutoff)`,
    `isInWarningWindow(now, cutoff, warnDays)`.
- `src/shared/logger.ts` — no new error codes needed; reuse
  `ErrorCode.DATA_INVALID` for malformed `READ_ONLY_FROM`.
- `src/ui/templates/admin/nav.tsx` — admin banner now also renders
  the warning state, both states deep-link to `getRenewalUrl()` when
  set, fall back to current generic text when not.
- `src/ui/templates/public.tsx` — same treatment for the public-side
  banner shown when `isReadOnly()` is true; also surface the
  pre-expiry warning to logged-out visitors? **No** — warning is
  admin-facing only for v1 (customer admin sees the nudge; public
  visitors don't need to know the site is about to expire).

**Tests**

- `test/lib/env.test.ts`
  - `READ_ONLY=true` ⇒ read-only regardless of date.
  - `READ_ONLY_FROM` in the past ⇒ read-only.
  - `READ_ONLY_FROM` in the future, outside warning window ⇒ writable,
    no warning.
  - `READ_ONLY_FROM` in the future, inside warning window ⇒ writable,
    warning shown.
  - `READ_ONLY_FROM` unset ⇒ writable, no warning.
  - `READ_ONLY_FROM` malformed ⇒ writable (fail open), logs error.
  - `READ_ONLY_WARN_DAYS` unset ⇒ defaults to 14.
  - `READ_ONLY_WARN_DAYS` invalid ⇒ defaults to 14, logs error.
- `test/routes/read-only.test.ts` — existing read-only-mode page
  rendering still triggers when `READ_ONLY_FROM` is in the past.
- `test/templates/admin/nav.test.ts` — warning banner CTAs point at
  `RENEWAL_URL` when set, fall back to generic copy when not.

---

### Phase 3 — Initial deadline at site assignment

**Files**

- `src/shared/builder.ts`
  - Extend `BuildSiteInput` with optional `readOnlyFrom?: string`,
    `renewalUrl?: string`, and `readOnlyWarnDays?: number`.
  - Push them into the secrets array when set:
    `["READ_ONLY_FROM", readOnlyFrom]`,
    `["RENEWAL_URL", renewalUrl]`,
    `["READ_ONLY_WARN_DAYS", String(readOnlyWarnDays)]` (only if
    explicitly set; otherwise the built site uses its 14-day default).
  - `BuildSiteResult` doesn't need to change (we already know the
    scriptId on the host).
- `src/shared/site-assignment.ts`
  - `assignSitesForEntries`: after `assignBuiltSite`, before the email:
    1. Require `event.initial_site_months > 0` — this is a form
       invariant (Phase 6), but assert defensively here so an admin
       bypassing the form via the API doesn't end up with a
       deadline-less paid site.
    2. Require `DEFAULT_MONTHLY_RENEWAL_PRICE` to be a positive
       integer. If unset, log + ntfy and abort assignment of this
       entry (rest of the batch continues). The customer's payment
       has already been captured, so this surfaces as an admin
       support ticket rather than a customer error.
    3. Compute the initial cutoff via
       `addMonthsIso(nowIso(), event.initial_site_months)`.
    4. Push it to the script via `pushReadOnlyFrom(site, cutoffIso)`
       (helper introduced in Phase 5).
    5. Create the per-site renewal event (Phase 4 helper) and push
       `RENEWAL_URL = https://<host>/<renewalSlug>` to the script.
- `src/shared/dates.ts` (new file, or extend `now.ts`) —
  `addMonthsIso(fromIso, months)` with end-of-month clamping
  (Jan 31 + 1mo → Feb 28/29).

**Tests**

- `test/lib/dates.test.ts` — `addMonthsIso` covers:
  - End-of-month clamp (`2026-01-31` + 1 → `2026-02-28`).
  - Leap-year clamp (`2024-01-31` + 1 → `2024-02-29`).
  - 30-day month clamp (`2026-03-31` + 1 → `2026-04-30`).
  - Year rollover (`2026-12-15` + 1 → `2027-01-15`).
  - 12-month renewal (`2026-05-17` + 12 → `2027-05-17`).
  - Zero months returns the input.
- `test/lib/site-assignment.test.ts`
  - With `event.initial_site_months = 3` and
    `DEFAULT_MONTHLY_RENEWAL_PRICE=500`, assignment pushes
    `READ_ONLY_FROM` = now + 3 months to the script and persists
    the value to `built_sites.read_only_from`.
  - With `DEFAULT_MONTHLY_RENEWAL_PRICE` unset, assignment aborts
    cleanly, logs `ErrorCode.CONFIG_MISSING` (or similar), no edge
    secrets pushed, no renewal event created.
  - With `event.initial_site_months = 0`, defensive assertion fires
    and entry is rejected (covers API-bypass case).
  - With `quantity = 3`, three separate sites are assigned, each gets
    its own renewal event and its own `RENEWAL_URL` pushed to its
    own edge script.
  - Stubs `bunnyCdnApi.setEdgeScriptSecret` and asserts call args.

---

### Phase 4 — Per-site renewal event creation

**Files**

- `src/shared/db/built-sites.ts` — add `getBuiltSiteByRenewalEventId`
  and `getRenewalEventIdForSite` helpers using
  `events.renewal_for_site_id`.
- `src/shared/site-assignment.ts`
  - New helper `createRenewalEventForSite(site)`:
    - Builds a renewal event row via `eventsTable.insert` with the
      defaults listed in *Decisions → Coupling renewal events to sites*.
    - Returns the inserted event (with its public slug + URL).
  - Update the post-`assignBuiltSite` block to call it, then persist
    `renewalEventId` into the site-data blob (`v: 2`).
- `src/shared/config.ts` — add `getRenewalUrlForSlug(slug: string)`
  built on existing `getEffectiveDomain()`.
- `src/features/admin/events.ts` — make `renewal_for_site_id`,
  `months_per_unit`, `initial_site_months` read-only after creation
  for renewal events (admin can edit price/name/quantity caps,
  but should never reassign the linkage).

**Tests**

- `test/lib/site-assignment.test.ts`
  - Assignment creates exactly one renewal event linked to the site.
  - Renewal event has `purchase_only=1, hidden=1, assign_built_site=0,
    renewal_for_site_id=<id>, months_per_unit=1` and a unique slug.
  - Renewal URL written to the script as `RENEWAL_URL`.

---

### Phase 5 — Renewal payment → deadline bump

**Files**

- `src/shared/site-assignment.ts` — extract `pushReadOnlyFrom(site,
  cutoffIso)` used by both initial assignment (Phase 3) and renewal
  (this phase). Order is critical:
  1. Call `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId,
     "READ_ONLY_FROM", cutoffIso)`.
  2. **Only on success**: `builtSitesTable.update(site.id,
     { readOnlyFrom: cutoffIso })`.
  3. On failure: log `ErrorCode.CDN_REQUEST`, ntfy, return an error
     to the caller. Host-side date stays at the previous value.
- `src/shared/webhook.ts`
  - New `applyRenewalsForEntries(entries)` helper, mirroring
    `assignAndNotifyBuiltSites`:
    - Filter entries to those whose event has
      `renewal_for_site_id != null`.
    - For each: load the site, compute the new deadline:
      `base = max(now, site.read_only_from || now)`
      `newIso = addMonthsIso(base, attendee.quantity * event.months_per_unit)`
      then call `pushReadOnlyFrom(site, newIso)`.
    - Log via `logActivity` ("Renewal of '<site name>' for N months").
  - In `logAndNotifyRegistration`, add
    `addPendingWork(applyRenewalsForEntries(entries))` next to the
    existing pending-work calls.

**Tests**

- `test/lib/renewals.test.ts` (new)
  - Renewal for 3 months: site with `read_only_from` 10 days from now
    becomes `now + 10d + 3 months` (clamped month math).
  - Expired site (`read_only_from` in the past): renewal makes it
    `addMonthsIso(now, N)` (not past + N).
  - Quantity multiplies by `months_per_unit` (set
    `months_per_unit=3`, qty=2 ⇒ +6 months).
  - Stripe webhook stub fires through to
    `bunnyCdnApi.setEdgeScriptSecret` exactly once with the computed
    ISO.
  - Entry without `renewal_for_site_id` is ignored.
  - `setEdgeScriptSecret` failure path: host-side `read_only_from`
    is **not** updated; error is logged + ntfy'd.
  - End-of-month: site with `read_only_from = 2026-01-31` + 1mo
    renewal lands on `2026-02-28`.

---

### Phase 6 — Admin surfaces & quality of life

**Files**

- `src/ui/templates/admin/built-sites.tsx` (or wherever the list lives
  — likely a generic CRUD template; search for `builtSitesCrudTable`)
  - Show `read_only_from` per row (formatted, "never", "expired N
    days ago", "in N days").
- Per-site detail view:
  - Link to the renewal event.
  - **"Re-sync deadline"** button (POST) — re-pushes the host-side
    `read_only_from` to the edge script via `pushReadOnlyFrom`. The
    primary recovery path when a Bunny push failed during renewal or
    initial assignment.
  - Manual **"Set deadline"** override form (host operator only) —
    pick a date, host stores it and pushes via `pushReadOnlyFrom`.
- Source event admin form (`src/ui/templates/fields.ts`,
  `src/ui/templates/admin/events.tsx`):
  - Add `initial_site_months` field, only shown when
    `assign_built_site=1`. Help text: "Months of access granted on
    initial purchase. The customer can renew later for more time."
  - **Validation: > 0 is required when `assign_built_site=1`.** Reject
    `0` on save with an inline error.
- Renewal event admin form:
  - "Renewal" tag in the events list next to the event name, with
    the linked site name appended (e.g. "Renew 00042 · Renewal").
  - On the renewal event's edit page, lock `renewal_for_site_id`,
    `months_per_unit`, and `assign_built_site` (display as a banner,
    not editable inputs). Price, name, slug, `max_quantity` remain
    editable.

**Tests**

- `test/templates/admin/built-sites.test.ts` — formatted deadline
  appears, "Re-sync deadline" and override form post to the expected
  routes and call `pushReadOnlyFrom`.
- `test/admin-api-events.test.ts`
  - `initial_site_months` round-trips on edit/save.
  - Saving an `assign_built_site=1` event with `initial_site_months=0`
    is rejected with a clear error message.
  - Renewal event edit page cannot mutate `renewal_for_site_id`,
    `months_per_unit`, or `assign_built_site`.
- `test/templates/admin/events.test.ts` — Renewal tag + linked site
  name render in the events list for renewal events.

---

### Phase 7 — Regression + integration

**Files**

- `test/integration/*` — one end-to-end test:
  1. Admin creates a paid event with `assign_built_site=1`,
     `initial_site_months=2`, `max_quantity=3`.
  2. Customer pays for `quantity=2` → two sites are assigned, two
     renewal events are created, each with its own slug, each gets
     `READ_ONLY_FROM = now + 2 months` pushed independently.
  3. Customer visits one site's `RENEWAL_URL`, pays for `quantity=3`
     → only that site's `READ_ONLY_FROM` advances by 3 months; the
     other site's deadline is unchanged.
  4. Stub `bunnyCdnApi.setEdgeScriptSecret` to assert the exact value
     pushed at each step, scoped to the right `bunnyScriptId`.
- Bunny API failure path: simulate a `setEdgeScriptSecret` error and
  assert the host-side `built_sites.read_only_from` is **not** advanced
  (so the customer doesn't pay for time that never landed on the
  edge). Confirm the admin "Re-sync deadline" button (Phase 6)
  recovers the state in a follow-up assertion.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Bunny secret push silently fails after payment captured | Persist new `read_only_from` only after success; log + ntfy on failure; admin "Re-sync deadline" button replays the push from the stored value. |
| Customer renews on a still-active site → eats their remaining time | `base = max(now, site.read_only_from)` keeps stacking forward. Tested. |
| Renewal slug guessable | `hidden=1` + `x-robots-noindex` + the URL is only known to the site owner via `RENEWAL_URL` on the edge script. Optional: lengthen slug for renewal events specifically. |
| Site is deleted but renewal event lingers | Add `renewal_for_site_id` cascade in `deleteBuiltSite`: also delete the linked event. |
| Source event is deleted but assignment already happened | No-op — renewal event is the only post-assignment link; source event is no longer relevant. |
| Admin edits `renewal_for_site_id` by hand and breaks the link | Field is non-editable in the admin event form for renewal events (read-only banner). |
| Edge runtime caches old secrets | Bunny secrets propagate via the secrets API; verify this in Phase 3 manual smoke test. If propagation requires a republish, add `publishEdgeScript` to the helper. |
| Malformed `READ_ONLY_FROM` locks customer out | Fail open: invalid value treated as "no cutoff", logged. |
| Clock skew between host and edge | Both run on Bunny's infra; `Date.now()` skew is tiny relative to month granularity. Document, don't engineer around. |
| `initial_site_months=0` on a paid built-site sale | Form rejects on save (Phase 6). Assignment defensively re-checks and logs if it sees 0 (API-bypass). |
| `DEFAULT_MONTHLY_RENEWAL_PRICE` unset while a paid site is being assigned | Assignment aborts cleanly per-entry, logs + ntfy. Customer's payment is already captured, so this surfaces as a support ticket — fix the env var, click "Re-sync deadline". |
| Refund issued for a renewal | Out of scope for v1: customer keeps the time they paid for, refund returns money only. Document. |
| One checkout buys N sites; rollback when one of the N edge pushes fails | Each site is processed independently; failures leave that site's host-side date unchanged and log per-site. No partial rollback of the others. |

## File-change summary (estimated)

| Area | Files | Notes |
|---|---|---|
| Schema | `migrations.ts`, `events.ts` (db), `built-sites.ts`, `types.ts` | 4 new columns + blob v2 |
| Read-only semantics | `env.ts` | `isReadOnly`, `isReadOnlyWarning`, `getRenewalUrl`, `getReadOnlyCutoffIso` |
| Banner UI | `templates/admin/nav.tsx`, `templates/public.tsx` | Pre-expiry warning + read-only banner both deep-link to `RENEWAL_URL` |
| Builder | `builder.ts` | Pass `READ_ONLY_FROM`, `RENEWAL_URL`, `READ_ONLY_WARN_DAYS` secrets |
| Assignment + renewal create | `site-assignment.ts`, `webhook.ts` | `pushReadOnlyFrom`, `createRenewalEventForSite`, `applyRenewalsForEntries`, env-var guard |
| Date math | new `dates.ts` | `addMonthsIso` with end-of-month clamp |
| Admin UI | `fields.ts`, `templates/admin/events.tsx`, `templates/admin/built-sites.tsx` | `initial_site_months` field (required > 0), Renewal tag in events list, deadline column, override + re-sync buttons |
| Tests | ~7 test files | All additive |

Roughly **10–12 source files**, **6–8 test files**.

## Resolved decisions (May 2026 Q&A)

1. **Renewal pricing source:** lives only on the renewal event row.
   Default at creation comes from a new env var
   `DEFAULT_MONTHLY_RENEWAL_PRICE`. Admin edits per-event afterwards.
2. **Env-var validation:** when `CAN_BUILD_SITES=true`, the renewal
   flow refuses to assign a built site if
   `DEFAULT_MONTHLY_RENEWAL_PRICE` is unset/non-positive. Check at
   request time inside `assignSitesForEntries` (edge has no
   startup phase). Surfaces as logged + ntfy'd admin support ticket.
3. **Renewal event creation timing:** at site assignment (one event
   per site, even on multi-site checkouts).
4. **Multi-site purchases (qty > 1):** each site gets its own renewal
   event with its own slug + `RENEWAL_URL`.
5. **Initial deadline column:** new `events.initial_site_months`,
   required > 0 when `assign_built_site=1`.
6. **Expiry behaviour:** full read-only at `READ_ONLY_FROM`. Warning
   banner shown `READ_ONLY_WARN_DAYS` days before (new env var,
   integer, default 14). Both banners deep-link to `RENEWAL_URL`.
7. **Renewal event admin listing:** mixed into the main events list
   with a "Renewal" tag and the linked site name. Renewal-specific
   fields (`renewal_for_site_id`, `months_per_unit`,
   `assign_built_site`) are locked on edit.
8. **Refunds:** out of scope for v1. Customer keeps paid-for time.
9. **Renewal URL shape:** regular public event page
   (`https://<host>/<slug>`) — `hidden=1, purchase_only=1` already
   does what we need; no custom route.
10. **Month arithmetic:** `addMonthsIso` clamps to last day of the
    target month (Jan 31 + 1mo → Feb 28/29).
11. **Push failure after renewal payment:** don't advance host-side
    date, log + ntfy, recover via the admin "Re-sync deadline"
    button on the built-site detail page.

## Still to confirm

1. **Bunny secret propagation:** does `setEdgeScriptSecret` propagate
   without a `publishEdgeScript` call? Verify with a Phase 3 manual
   smoke test. If not, fold `publishEdgeScript` into
   `pushReadOnlyFrom` (cheap, idempotent).
2. **Phase 8 (out of scope but obvious next):** cron over
   `built_sites` rows whose `read_only_from` falls in the next
   `READ_ONLY_WARN_DAYS` and send a renewal-nudge email. Land after
   v1 ships.
