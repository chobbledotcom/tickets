# Monthly renewals for built sites

## Goal

Customers who sign up online and get a built site delivered should be able
to keep that site running by paying a monthly fee. Each site can be
renewed via a private URL that points at a shared "renewal tier" event
on the host instance; paying for `N` months extends the site's read-only
deadline by `N` months. When the deadline passes, the built site flips
itself into read-only mode (the existing `READ_ONLY` machinery) until
the customer renews.

This is two systems glued together:

1. The **host** instance owns one or more tier event(s) (regular events
   in the `events` table, just `purchase_only=1, hidden=1`), takes
   payment via the existing payment pipeline, then writes the new
   deadline back onto the built site's edge script as a secret.
2. The **built site** treats a new `READ_ONLY_FROM` secret (an ISO
   timestamp) as the source of truth for its own read-only mode. The
   existing `READ_ONLY=true` boolean still works as a hard override.

The two halves are coupled by:

- `built_sites.bunnyScriptId` (already stored) — lets the host call the
  Bunny CDN API to update secrets on the customer's edge script.
- A `RENEWAL_URL` secret on the built site — a `/renew/?t=<token>`
  link the built site can show in its read-only / pre-expiry banners.
- A renewal token stored on the `built_sites` row, used to look up
  which site a renewal payment belongs to.

## Codebase findings (May 2026)

These findings drove the design choices below:

- **Built sites table** (`src/shared/db/built-sites.ts`): rows already
  hold `bunnyScriptId`, `bunnyUrl`, `dbUrl`, `dbToken` (encrypted blob
  with version field `v: 1`), plus the `assigned_attendee_id` /
  `assigned_event_id` set by `assignBuiltSite` after a purchase webhook
  fires. The blob shape is versioned — easy to extend to `v: 2`.
- **Provisioning entry point** (`src/shared/site-assignment.ts`):
  `assignAndNotifyBuiltSites` runs in `addPendingWork` after every
  registration webhook (`src/shared/webhook.ts:173`). When the
  purchased event has `assign_built_site=1`, it pulls an available
  built site (or calls `buildSiteForAssignment` to make one), assigns
  it, and emails the URL.
- **Site builder** (`src/shared/builder.ts`): `buildSite` creates the
  edge script and pushes secrets (`DB_URL`, `DB_TOKEN`,
  `DB_ENCRYPTION_KEY`, `BUNNY_SCRIPT_ID`, plus copied
  `HOST_SECRET_KEYS`), then publishes. Secrets propagate **without
  republish** via `bunnyCdnApi.setEdgeScriptSecret(scriptId, name,
  value)` — confirmed by the user.
- **Read-only mode** (`src/shared/env.ts:36`): `isReadOnly()` is a
  single function reading `READ_ONLY` from `getEnv`. Called from
  `readOnlyGuard` (`src/features/index.ts`) and a dozen template
  files. Single source of truth — easy to extend.
- **Events** already have everything we need for tier events: unique
  `slug` + `slug_index` blind index, payment flow with Stripe/Square,
  `purchase_only` (no ticket), `hidden` (excluded from public
  listings, sets `x-robots-noindex`), `unit_price`. A tier event is
  conceptually `purchase_only=1, hidden=1, months_per_unit > 0`.
- **Existing token blind-index pattern** (`src/shared/db/attendees/pii.ts`,
  `src/shared/crypto/hashing.ts`): attendees store `ticket_token`
  (in the encrypted PII blob) plus `ticket_token_index` (HMAC of the
  token, in a regular column). Lookup by token = HMAC the input,
  query the index column. Renewals use the same pattern.
- **`generateSecureToken()`** (`src/shared/crypto/utils.ts:72`):
  already exists, produces 32 random bytes base64url-encoded. Reuse.
- **Payment pipeline metadata** (`src/shared/payments.ts`,
  `src/shared/payment-helpers.ts`): all payment session metadata
  flows through a strongly-typed `SessionMetadata` shape with a
  fixed set of fields (`_origin`, `name`, `email`, `items`, `date`,
  `address`, `phone`, `special_instructions`, `answer_ids`). To
  carry "this payment renews site X", we extend this shape with one
  optional field (`site_token`).
- **Payment pipeline assumes attendees** (`src/features/api/webhooks.ts`):
  every successful payment goes through `createAttendeeAtomic` →
  `processed_payments` two-phase lock → `logAndNotifyRegistration`.
  Renewals reuse this end-to-end (one attendee row per renewal acts
  as the audit receipt; the existing refund-on-failure machinery and
  two-phase locking come for free). The renewal-specific side-effect
  (bumping `READ_ONLY_FROM`) plugs into the existing post-finalize
  pending-work chain alongside `assignAndNotifyBuiltSites`.
- **Public ticket flow** (`src/features/public/`): the `/<slug>` page
  renders a per-event booking form, posts to a ticket-submit route,
  which calls `runCheckoutFlow` → provider's
  `createCheckoutSession` with a `CheckoutIntent`. Renewal route
  reuses `runCheckoutFlow` directly; only the form and the metadata
  field differ.
- **Settings** (`src/shared/db/settings.ts`): well-developed sync-read
  / async-write API. Adding a new setting requires touching
  `CONFIG_KEYS`, the read snapshot, the update API, and the admin
  settings page. Avoiding new settings keeps churn down.
- **Admin built-sites CRUD** (`src/features/admin/built-sites.ts`,
  `src/ui/templates/admin/built-sites.tsx`): standard owner-CRUD
  scaffolding via `createOwnerCrudHandlers`. Per-site action buttons
  (rotate token, re-sync deadline, override) need their own POST
  routes outside the CRUD pattern.

## Decisions

### Naming

- New secret on the built site: **`READ_ONLY_FROM`** — ISO timestamp.
  Site is read-only iff `now >= READ_ONLY_FROM`. Existing
  `READ_ONLY=true` stays as a hard override.
- New secret on the built site: **`RENEWAL_URL`** — absolute URL of
  the form `https://<host>/renew/?t=<token>`.
- New secret on the built site: **`READ_ONLY_WARN_DAYS`** — integer,
  default `14`. Controls how early the pre-expiry warning banner
  appears.
- Renewal events live in the existing `events` table. No new
  `event_type`. The flag is `months_per_unit > 0`.

### Schema additions

**`events` table:**

- `months_per_unit INTEGER NOT NULL DEFAULT 0` — when > 0 the event
  is treated as a renewal tier. The customer's `quantity` is
  multiplied by this value to compute the deadline bump
  (`quantity * months_per_unit` months). `1` for a monthly tier,
  `12` for an annual tier. Zero on every non-renewal event (default
  preserves existing behaviour).
- `initial_site_months INTEGER NOT NULL DEFAULT 0` — on the **selling**
  event (the `assign_built_site=1` one). Required `> 0` when
  `assign_built_site=1` (form validation). Drives the initial
  `READ_ONLY_FROM` cutoff at assignment.

**`built_sites` table:**

- `renewal_token_index TEXT NOT NULL DEFAULT ''` — HMAC blind index
  over the renewal token, unique. Lookup column for `/renew/?t=<token>`.
- `renewal_tier_event_id INTEGER DEFAULT NULL` — FK-by-convention to
  the tier event the site is currently on. Admin can change this in
  the built-site detail page (no token rotation needed). NULL means
  "no tier assigned yet" (legacy sites; renew route 404s).
- `read_only_from TEXT NOT NULL DEFAULT ''` — host-side cache of the
  cutoff currently set on the edge script. Updated only after a
  successful Bunny push. Used by the admin UI and the deadline-bump
  math (`base = max(now, read_only_from)`).

**Site-data blob bumps to `v: 2`:**

- Adds `rt?: string` — the renewal token (encrypted alongside other
  per-site secrets). Not strictly needed for runtime (we can rotate
  by regenerating + pushing a new URL), but stored so the admin UI
  can render the current `RENEWAL_URL` without re-deriving it.

**`SessionMetadata` (payment pipeline):**

- Add **optional** `site_token?: string`. Populated only by the
  renewal checkout route. Webhook side-effect chain reads it; if
  present, bumps the linked site's deadline. All other code paths
  ignore it.

### Renewal URL shape

- `https://<host>/renew/?t=<token>` — dedicated route, separate from
  the public event flow. Token is a 32-byte base64url string
  produced by `generateSecureToken()` (same primitive used elsewhere).
- Server-side lookup: HMAC the token via `hmacHash`, query
  `built_sites WHERE renewal_token_index = ?`. If the site has
  `renewal_tier_event_id = null` → 404.
- The route is its own handler, not a redirect to `/<slug>`. The
  rendered page shows: site name, current `read_only_from`, a months
  quantity picker (1..`max_quantity` of the tier event), the email
  field, and a Stripe / Square checkout button. POST creates a
  checkout session with the tier event as the line item and the
  `site_token` field in the session metadata.

### Why not couple the slug into the token

Earlier design considered `HMAC(site_id || tier_slug)`. Rejected
because the tier is recoverable from the DB (column on the site
row), so the token doesn't need to encode it. Decoupled means:

- Tier change = single column update on `built_sites`. No new URL,
  no edge-script push needed for tier change alone.
- Token rotation (e.g. revoking a leaked URL) = regenerate token,
  push new `RENEWAL_URL`. Independent of tier.
- Customer's URL is stable across tier changes (which the admin can
  do silently).

### No `DEFAULT_MONTHLY_RENEWAL_PRICE` env var

The earlier (per-site-event) plan needed an env var because we
auto-created an event row at assignment time and had to pick its
default price. In this design, the tier event row already exists
(admin creates it once, like any other event), with `unit_price`
set on the row itself. No env-var fallback needed.

The earlier env-var-must-be-set guard is replaced by a **"at least
one tier event must exist"** check at assignment time:

- A *qualifying* tier event is `purchase_only=1, hidden=1,
  months_per_unit > 0, active=1`.
- If zero qualifying tier events exist when a paid built-site
  assignment runs, the assignment aborts cleanly per-entry with a
  logged + ntfy'd error and no edge-script writes. Surfaces as an
  admin support ticket: "create a tier event first."
- If multiple qualifying tier events exist, assignment picks the
  cheapest one by `unit_price` (deterministic). Admin can switch
  the customer to a different tier from the built-site detail page.

### Initial deadline on first sale

On assignment of an `assign_built_site=1` event:

1. Defensive: re-check `initial_site_months > 0` (form validates
   this, but API-bypass is possible). Abort entry on failure.
2. Pick a tier event (per above). Abort entry on failure.
3. Generate a fresh `renewal_token` via `generateSecureToken()`.
   Store `renewal_token_index = hmacHash(token)` on the site row;
   store the raw token in the v:2 site-data blob (`rt`).
4. Set `renewal_tier_event_id` on the site row.
5. Compute `READ_ONLY_FROM = addMonthsIso(nowIso(),
   event.initial_site_months)`.
6. Push three secrets to the edge script via
   `bunnyCdnApi.setEdgeScriptSecret`:
   - `READ_ONLY_FROM = <cutoffIso>`
   - `RENEWAL_URL = https://<host>/renew/?t=<token>`
   - `READ_ONLY_WARN_DAYS = 14` (only if explicitly desired per-site;
     omit to use the built site's built-in default).
7. **Only on push success**, persist `read_only_from` to the
   built_site row. Failure path logs + ntfy and is recovered via
   the admin "Re-sync deadline" button (Phase 6).

For multi-site purchases (`quantity > 1` on the selling event):
each provisioned site gets its own token, its own URL, and its own
independent secrets push. One site's push failure does not roll
back the others.

### Payment → deadline bump

When a renewal payment succeeds:

1. Customer POSTs to `/renew/?t=<token>` (Phase 4 route). The
   handler validates the token, resolves the site + tier event,
   builds a `CheckoutIntent` whose single item is the tier event
   with `quantity = months` and `unitPrice = tier.unit_price`,
   plus a `site_token` field in the metadata.
2. Stripe/Square processes payment. Webhook fires → existing
   `processPaymentSession` validates and creates an attendee via
   the standard pipeline. The attendee row is the audit trail.
3. After `finalizeSession`, `logAndNotifyRegistration` runs (`src/shared/webhook.ts:164`).
4. New pending-work step `applyRenewalsForEntries(entries,
   sessionMetadata)`:
   - If `sessionMetadata.site_token` is empty → no-op (this isn't a
     renewal payment).
   - Look up site by `hmacHash(site_token)` against
     `renewal_token_index`. If missing → log + ntfy. (Shouldn't
     happen — token came from a checkout we just authored — but
     guards against rotation between checkout and webhook.)
   - For each entry where the event is the site's
     `renewal_tier_event_id`, compute:
     `base = max(now, site.read_only_from || now)`
     `newIso = addMonthsIso(base, attendee.quantity * event.months_per_unit)`
     then call `pushReadOnlyFrom(site, newIso)`.
   - Log via `logActivity` ("Renewal of '<site name>' for N months").
5. Refunds are **out of scope for v1** — if a renewal is refunded
   later, the customer keeps the time they paid for. Document.

### Built site read-only behaviour

- New `src/shared/env.ts`:
  ```ts
  export const isReadOnly = (): boolean => {
    if (getEnv("READ_ONLY") === "true") return true;
    const cutoff = getEnv("READ_ONLY_FROM");
    if (!cutoff) return false;
    const parsed = Date.parse(cutoff);
    if (Number.isNaN(parsed)) {
      logError({ code: ErrorCode.DATA_INVALID,
                 detail: `READ_ONLY_FROM unparseable: ${cutoff}` });
      return false; // fail open
    }
    return Date.now() >= parsed;
  };

  export const isReadOnlyWarning = (): boolean => {
    if (isReadOnly()) return false;
    const cutoff = getEnv("READ_ONLY_FROM");
    if (!cutoff) return false;
    const parsed = Date.parse(cutoff);
    if (Number.isNaN(parsed)) return false;
    const warnDays = parseWarnDays(getEnv("READ_ONLY_WARN_DAYS"));
    return Date.now() >= parsed - warnDays * 86_400_000;
  };
  ```
- Plus pure helpers (`isReadOnlyFromCutoff(now, cutoff)`,
  `isInWarningWindow(now, cutoff, warnDays)`,
  `parseWarnDays(raw): number`) so date math is testable without
  env mocking.
- `getReadOnlyCutoffIso(): string | null` and
  `getRenewalUrl(): string | null` exposed for templates.

### Banner UX

Both banners deep-link to `RENEWAL_URL` when set:

- **Pre-expiry (`isReadOnlyWarning()`)**: "Your site expires on
  `<date>` — Renew now" rendered in the admin nav (admin-facing
  only for v1; public visitors don't need to know).
- **Read-only (`isReadOnly()`)**: "This site is in read-only mode —
  Renew now" rendered in both admin and public pages.

When `RENEWAL_URL` is unset (legacy site / admin-forced read-only),
banner falls back to current generic copy with no link.

### Month arithmetic

`addMonthsIso(fromIso, months)` clamps to the last day of the target
month (Jan 31 + 1mo → Feb 28/29). Lives in a new `src/shared/dates.ts`
(or `now.ts` if you prefer the existing module).

### Admin surface for renewals

- `built_sites` admin index gains a `Read-only from` column,
  formatted (`"in 14 days"`, `"expired 3 days ago"`, `"never"`).
- Per-site detail page (`/admin/built-sites/<id>/edit`) gains a
  "Renewal" panel:
  - Current renewal token (regenerable via "Rotate token" button —
    POST to `/admin/built-sites/<id>/rotate-renewal-token`).
  - Current tier event (selectable dropdown of qualifying tier
    events — POST to `/admin/built-sites/<id>/set-renewal-tier`).
  - "Re-sync deadline" button — re-pushes the host-side
    `read_only_from` to the edge script
    (`/admin/built-sites/<id>/re-sync-deadline`). Primary recovery
    path for failed Bunny pushes during initial assignment or
    renewal.
  - "Override deadline" form — pick an arbitrary date, host persists
    and pushes (`/admin/built-sites/<id>/override-deadline`). For
    support comps / disputes.
  - Both rotate-token and set-tier admin actions push the new
    `RENEWAL_URL` to the edge.
- The selling-event admin form
  (`src/ui/templates/admin/events.tsx`, `src/ui/templates/fields.ts`):
  - Add `initial_site_months` field (number input, min 1, default 1),
    only shown / required when `assign_built_site=1`.
- The tier-event admin form: `months_per_unit` field (number input,
  min 1). Help text: "How many months one ticket buys."
- Tier events render with a `Renewal` tag in the admin events list,
  with their `months_per_unit` shown beside the price.

## Non-goals

- Subscriptions / auto-renew. Customer renews manually each cycle.
- Pro-rating, refunds for unused months.
- Email reminders before expiry — Phase 8 (cron over `built_sites`
  where `read_only_from` ∈ `[now, now + READ_ONLY_WARN_DAYS]`).
- A "self-renewal" page rendered by the built site itself; v1 links
  out to the host's `/renew/` page.
- Multi-currency renewal pricing (uses existing `settings.currency`).
- Renewal events showing up in aggregate revenue admin reports.

## Phases

Each phase is intended to be a shippable, typechecking, test-passing
state. Defaults are neutral so existing sites and events keep working
unchanged until the renewal flow is wired up end-to-end in Phase 5.

---

### Phase 1 — Schema + types

**Files**

- `src/shared/db/migrations.ts`
  - Add to `events` columns:
    - `["months_per_unit", "INTEGER NOT NULL DEFAULT 0"]`
    - `["initial_site_months", "INTEGER NOT NULL DEFAULT 0"]`
  - Add to `built_sites` columns:
    - `["renewal_token_index", "TEXT NOT NULL DEFAULT ''"]`
    - `["renewal_tier_event_id", "INTEGER DEFAULT NULL"]`
    - `["read_only_from", "TEXT NOT NULL DEFAULT ''"]`
  - Add to `built_sites` indexes:
    - `{ columns: ["renewal_token_index"],
         name: "idx_built_sites_renewal_token_index", unique: true }`
    - Note: unique-on-empty-string would block empty values. Use a
      partial unique index if libsql supports it, otherwise gate at
      the application layer (assignment always sets a non-empty
      token, never produces collisions in practice).
  - Bump `LATEST_UPDATE` to
    `"add monthly renewals to events + built_sites"`.
- `src/shared/types.ts`
  - Extend `Event` with `months_per_unit: number;
    initial_site_months: number;`.
- `src/shared/db/events.ts`
  - Schema: `months_per_unit: col.withDefault(() => 0),
    initial_site_months: col.withDefault(() => 0)`.
  - `EventInput`: add optional `monthsPerUnit?: number;
    initialSiteMonths?: number;`.
- `src/shared/db/built-sites.ts`
  - Extend `BuiltSiteRow`, `BuiltSite`, the schema, `rowToBuiltSite`,
    and the CRUD adapter to surface
    `renewalTokenIndex: string`,
    `renewalTierEventId: number | null`,
    `readOnlyFrom: string`.
  - `SiteDataBlob` bumps to `v: 2` and gains `rt?: string`. `parseSiteDataBlob` must
    still accept `v: 1` blobs (legacy sites); `rt` is undefined when
    missing.
  - New helpers:
    `getBuiltSiteByRenewalTokenIndex(tokenIndex: string): Promise<BuiltSite | null>`
    (`SELECT … WHERE renewal_token_index = ?`).

**Tests**

- `test/lib/db.test.ts`
  - Round-trip an event with the two new fields.
  - Round-trip a built_site with all three new columns set.
  - `getBuiltSiteByRenewalTokenIndex` returns the matching site,
    returns null when no match.
  - Legacy v:1 blob still decodes correctly (no `rt` field).

---

### Phase 2 — Built site read-only-from + warning banner

This is the customer-facing payoff: even with no renewal flow wired
up, a site with `READ_ONLY_FROM` set in the past becomes read-only,
and one within `READ_ONLY_WARN_DAYS` shows a pre-expiry warning.

**Files**

- `src/shared/env.ts`
  - Replace `isReadOnly` body with the helper shown in *Decisions*.
  - Add `isReadOnlyWarning(): boolean`.
  - Add `getReadOnlyCutoffIso(): string | null`.
  - Add `getRenewalUrl(): string | null` (reads `RENEWAL_URL`).
  - Pure helpers (separate functions, no env access):
    `isReadOnlyFromCutoff(now: number, cutoff: string): boolean`,
    `isInWarningWindow(now: number, cutoff: string, warnDays: number): boolean`,
    `parseWarnDays(raw: string | undefined): number` (default 14,
    treats non-integer / ≤0 as 14, logs once on bad input).
- `src/ui/templates/admin/nav.tsx`
  - Existing `READ_ONLY_BANNER` becomes
    `renderReadOnlyBanner({ readOnly, warning, cutoffIso, renewalUrl })`.
  - Pre-expiry warning shows when `warning` true.
  - Both banners deep-link to `renewalUrl` when set; fall back to
    generic copy when unset.
- `src/ui/templates/public.tsx`
  - Read-only banner (already shown when `isReadOnly()`) gets the
    same `renewalUrl` CTA treatment. **No** public-facing warning
    banner for v1 (admin-only nudge).
- `src/ui/static/mvp.css`
  - New `.read-only-banner-warning` style (yellow-ish vs the existing
    `.read-only-banner` red).

**Tests**

- `test/lib/env.test.ts`
  - `READ_ONLY=true` ⇒ read-only regardless of date, warning false.
  - `READ_ONLY_FROM` in the past ⇒ read-only, warning false.
  - `READ_ONLY_FROM` in the future, outside warning window
    ⇒ writable, warning false.
  - `READ_ONLY_FROM` in the future, inside warning window
    ⇒ writable, warning true.
  - `READ_ONLY_FROM` unset ⇒ writable, warning false.
  - `READ_ONLY_FROM` malformed ⇒ writable (fail open), logs
    `DATA_INVALID`.
  - `READ_ONLY_WARN_DAYS` unset ⇒ defaults to 14.
  - `READ_ONLY_WARN_DAYS = "0"` or `"-3"` or `"abc"` ⇒ defaults to
    14, logs once.
- `test/lib/env.test.ts` (pure-helper coverage without env)
  - `isInWarningWindow(now, cutoff, 14)` for cutoff exactly 14 days
    out, 14 days + 1ms out, expired, just-expired.
- `test/templates/layout.test.ts` / `test/templates/admin/nav.test.ts`
  - Warning banner present when `isReadOnlyWarning()` true.
  - CTA link uses `getRenewalUrl()` when set; falls back to generic
    when not.
- `test/routes/read-only.test.ts` — existing read-only-mode page
  rendering still triggers when `READ_ONLY_FROM` is in the past.

---

### Phase 3 — Initial deadline + token at site assignment

**Files**

- `src/shared/builder.ts`
  - Extend `BuildSiteInput` with optional `readOnlyFrom?: string`,
    `renewalUrl?: string`, `readOnlyWarnDays?: number`.
  - Push them into the secrets array when defined:
    `["READ_ONLY_FROM", readOnlyFrom]`,
    `["RENEWAL_URL", renewalUrl]`,
    `["READ_ONLY_WARN_DAYS", String(readOnlyWarnDays)]`.
- `src/shared/dates.ts` (new file)
  - `addMonthsIso(fromIso: string, months: number): string`. End-of-
    month clamp implementation: build with
    `Date.UTC(y, m + months, Math.min(originalDay, daysInTargetMonth))`,
    preserve hour/minute/second/ms.
- `src/shared/site-assignment.ts`
  - New helper `pickTierEvent(): Promise<EventWithCount | null>`:
    `getAllEvents()` → filter
    `purchase_only=1 && hidden=1 && months_per_unit > 0 && active=1`
    → cheapest by `unit_price`. Returns null when none exist.
  - New helper `generateRenewalToken(): Promise<{ token: string;
    index: string }>` — wraps `generateSecureToken` + `hmacHash`.
  - New helper `pushReadOnlyFrom(site: BuiltSite, cutoffIso: string,
    renewalUrl?: string): Promise<{ ok: true } | { ok: false; error: string }>`:
    1. `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId,
       "READ_ONLY_FROM", cutoffIso)` → on failure, return `{ ok: false }`.
    2. If `renewalUrl` provided:
       `setEdgeScriptSecret(..., "RENEWAL_URL", renewalUrl)` →
       failure returns `{ ok: false }`.
    3. On success: `builtSitesTable.update(site.id,
       { readOnlyFrom: cutoffIso, ...(token bits if rotating) })`.
    4. Return `{ ok: true }`.
  - `assignSitesForEntries` (existing): for each
    `assign_built_site=1` entry:
    1. Defensive: assert `event.initial_site_months > 0`. On 0,
       skip + log `DATA_INVALID`.
    2. Call `pickTierEvent()`. On null, skip + log `CONFIG_MISSING`
       (new error code) + ntfy.
    3. For each ticket in `attendee.quantity`:
       a. Assign a built site (existing flow).
       b. Generate a renewal token. Persist token in v:2 site-data
          blob + `renewal_token_index` column + set
          `renewal_tier_event_id`.
       c. Compute `cutoff = addMonthsIso(nowIso(),
          event.initial_site_months)`.
       d. Call `pushReadOnlyFrom(site, cutoff,
          renewalUrlFor(token))`. On failure: leave host-side
          `read_only_from` empty (don't lie about state); admin's
          "Re-sync deadline" replays from a sane state later (which
          will be `nowIso() + initial_site_months` re-computed —
          fine for first-push recovery).
    4. Email goes out as today.
- `src/shared/config.ts` — `renewalUrlFor(token): string`:
  `https://${getEffectiveDomain()}/renew/?t=${encodeURIComponent(token)}`.
- `src/shared/logger.ts` — new `ErrorCode.CONFIG_MISSING` for the
  "no tier event" case (or reuse `DATA_INVALID` — fine either way,
  but a dedicated code makes log grep'ing easier).

**Tests**

- `test/lib/dates.test.ts`
  - End-of-month clamp (`2026-01-31 + 1mo → 2026-02-28`).
  - Leap-year (`2024-01-31 + 1mo → 2024-02-29`).
  - 30-day month clamp (`2026-03-31 + 1mo → 2026-04-30`).
  - Year rollover (`2026-12-15 + 1mo → 2027-01-15`).
  - 12-month renewal (`2026-05-17 + 12mo → 2027-05-17`).
  - Zero months returns the input (canonical-string equality).
  - Time component preserved.
- `test/lib/site-assignment.test.ts`
  - With one qualifying tier event and
    `event.initial_site_months = 3`:
    - Assignment generates a renewal token (32-byte base64url shape),
      persists `renewal_token_index` and `renewal_tier_event_id`.
    - Pushes `READ_ONLY_FROM = now + 3mo`, `RENEWAL_URL`, and
      persists `read_only_from`.
  - With `event.initial_site_months = 0` ⇒ assignment skips,
    logs `DATA_INVALID`, no edge writes.
  - With zero qualifying tier events ⇒ assignment skips, logs
    `CONFIG_MISSING`, no edge writes, no site assigned.
  - With two qualifying tier events, cheapest is selected as the
    site's tier.
  - With `quantity = 3` ⇒ three sites assigned, three independent
    tokens generated, three independent secret pushes (assert call
    count = 3 × secrets-per-site = 6 or 9 depending on inclusion
    of `RENEWAL_URL`/`READ_ONLY_WARN_DAYS`).
  - Bunny push failure on one site of three ⇒ that site's
    host-side `read_only_from` stays empty; the other two persist
    their values.
  - Stubs `bunnyCdnApi.setEdgeScriptSecret` and asserts call args.

---

### Phase 4 — `/renew/` route + form

**Files**

- `src/shared/payments.ts`
  - Extend `SessionMetadata`: add `site_token?: string` (optional).
  - Extend `BookingIntent`: add `siteToken?: string`.
- `src/shared/payment-helpers.ts`
  - `buildMetadata`: include `site_token` when the input has it.
  - `extractSessionMetadata`: surface `site_token` (default `""`).
  - `hasRequiredSessionMetadata` and `enforceMetadataLimits`: no
    change required (the token is a short base64url string, far
    below any provider's value limit).
- `src/features/api/webhooks.ts → extractIntent`
  - Surface `siteToken: metadata.site_token || undefined` on the
    returned `BookingIntent`.
- `src/features/public/renewal.ts` (new file)
  - `GET /renew/?t=<token>` handler:
    1. Extract `t` query param. If missing → 404.
    2. `hmacHash(token)` → `getBuiltSiteByRenewalTokenIndex(index)`.
       If missing → 404.
    3. If `site.renewalTierEventId == null` → 404
       (site not configured for renewals).
    4. Load tier event via `getEventWithCount(tierId)`. If missing
       / inactive / `purchase_only=0` / `months_per_unit <= 0`
       → render an admin-style error page ("This renewal link is no
       longer valid — please contact support").
    5. Render renewal form: site name + current `read_only_from` +
       quantity (months) selector (1..`tier.max_quantity`) + email
       + name + CSRF token + checkout button.
  - `POST /renew/?t=<token>` handler:
    1. Repeat lookup (must not trust client). Validate CSRF.
    2. Parse `quantity` (clamp to `1..tier.max_quantity`).
    3. Build `CheckoutIntent`:
       ```ts
       {
         name: form.name,
         email: form.email,
         items: [{ eventId: tier.id, slug: tier.slug, name: tier.name,
                   quantity: months, unitPrice: tier.unit_price }],
         date: null,
         siteToken: token,
       }
       ```
    4. Call `runCheckoutFlow("renewal site=…", request, …,
       errorRedirect("/renew/?t=<token>", msg))`.
- `src/features/index.ts`
  - Wire `/renew` into the lazy-routed dispatch alongside
    other public routes.
- `src/ui/templates/public/renewal.tsx` (new file)
  - `renewalPage({ site, tier, formValues, error?, csrf })`. Style
    matches the existing ticket form.

**Tests**

- `test/routes/renewal.test.ts` (new)
  - `GET /renew/?t=<valid-token>` renders the form with the site
    name and tier price.
  - `GET /renew/?t=<unknown-token>` → 404.
  - `GET /renew/` (no token) → 404.
  - `GET /renew/?t=<valid>` where `renewal_tier_event_id` is null
    → 404.
  - `GET /renew/?t=<valid>` where the linked tier event is inactive
    → renders the "link no longer valid" error page (not the form).
  - `POST /renew/?t=<valid>` with `quantity=3` creates a checkout
    session whose metadata contains `site_token=<token>`,
    `items[0].e=<tier.id>`, `items[0].q=3`,
    `items[0].p=tier.unit_price * 3`.
  - `POST` with `quantity=0` clamps to 1.
  - `POST` with `quantity > max_quantity` clamps down.
  - `POST` without CSRF → 403.
- `test/lib/payment-helpers.test.ts`
  - `buildMetadata` includes `site_token` when present, omits when
    absent.
  - `extractSessionMetadata` surfaces `site_token` (default `""`).
- `test/lib/webhooks.test.ts` (or wherever `extractIntent` lives)
  - `extractIntent` surfaces `siteToken` when present.

---

### Phase 5 — Webhook side-effect: bump `READ_ONLY_FROM`

**Files**

- `src/shared/webhook.ts`
  - New `applyRenewalsForEntries(entries: EmailEntry[], siteToken: string | undefined)`:
    - If `!siteToken` → no-op.
    - `hmacHash(siteToken)` → `getBuiltSiteByRenewalTokenIndex`.
      If missing → log `DATA_INVALID` ntfy with truncated token
      hash, no-op.
    - For each entry whose `event.id === site.renewalTierEventId`:
      `base = max(nowMs(), Date.parse(site.read_only_from || nowIso()))`
      `newIso = addMonthsIso(new Date(base).toISOString(),
                              attendee.quantity * event.months_per_unit)`
      `await pushReadOnlyFrom(site, newIso)` (no `renewalUrl` arg —
      not rotating).
    - On success, `logActivity(`Renewal of '${site.name}' for
      ${months} month(s)`)`.
  - In `logAndNotifyRegistration`, plumb `siteToken` through:
    - Caller already passes `entries: EmailEntry[]`. Add a second
      argument `siteToken: string | undefined`.
    - Add `addPendingWork(applyRenewalsForEntries(entries, siteToken))`
      next to the existing pending-work calls.
- `src/features/api/webhooks.ts → processPaymentSession`
  - Pass `intent.siteToken` through to `logAndNotifyRegistration`.
- `src/features/public/ticket-payment.ts → processFreeReservation`
  - Pass `undefined` (free reservations never renewals — they're
    always > $0 by construction, since tier events have a price).

**Tests**

- `test/lib/renewals.test.ts` (new)
  - Site with `read_only_from = now + 10d`, `months_per_unit = 1`,
    `quantity = 3` ⇒ new cutoff = `now + 10d + 3mo` (clamped).
  - Expired site (`read_only_from` in the past) + 6 month renewal
    ⇒ new cutoff = `now + 6mo` (not past + 6mo).
  - `months_per_unit = 3`, `quantity = 2` ⇒ +6 months.
  - `pushReadOnlyFrom` is called exactly once with the computed
    cutoff and the site's `bunnyScriptId`.
  - Entry with no `siteToken` ⇒ no Bunny call.
  - `siteToken` present but no matching site ⇒ logged, no Bunny call.
  - End-of-month: site with `read_only_from = 2026-01-31` + 1mo
    renewal lands on `2026-02-28`.
  - `pushReadOnlyFrom` failure: host-side `read_only_from` not
    advanced; activity log records failure rather than success.
  - End-to-end: stub a Stripe webhook event with `site_token` in
    metadata; `applyRenewalsForEntries` fires through to
    `bunnyCdnApi.setEdgeScriptSecret`.

---

### Phase 6 — Admin surfaces + lifecycle actions

**Files**

- `src/ui/templates/admin/built-sites.tsx`
  - List page: add `Read-only from` column using a formatter
    (`formatDeadlineLabel(iso, nowIso())`): `"never"`,
    `"expired N days ago"`, `"in N days"`, `"today"`.
  - Detail/edit page: new "Renewal" panel below the existing fields:
    - Current deadline (formatted) + raw ISO in a `<details>`.
    - Renewal URL with copy-to-clipboard.
    - Tier event: `<select>` of qualifying tier events, "Save"
      button → POST `/admin/built-sites/<id>/set-renewal-tier`.
    - "Rotate token" button → POST
      `/admin/built-sites/<id>/rotate-renewal-token`. Confirms
      with native `confirm()` ("The old URL will stop working").
    - "Re-sync deadline" button → POST
      `/admin/built-sites/<id>/re-sync-deadline`. Re-pushes
      `read_only_from`, `RENEWAL_URL` to the edge.
    - "Override deadline" form: date input → POST
      `/admin/built-sites/<id>/override-deadline`. Server validates,
      converts to ISO, calls `pushReadOnlyFrom`.
- `src/features/admin/built-sites.ts`
  - Four new POST routes (one per button). Each owner-gated.
  - `rotate-renewal-token`: `generateRenewalToken()` →
    `builtSitesTable.update(id, { renewalTokenIndex, /* blob with new rt */ })`
    → `pushReadOnlyFrom(site, currentDeadline, newRenewalUrl)`.
  - `set-renewal-tier`: validate the picked event is a qualifying
    tier event, update `renewal_tier_event_id`. No edge-script
    write needed (the tier is resolved server-side at /renew/).
  - `re-sync-deadline`: call `pushReadOnlyFrom(site,
    site.read_only_from)`. If `read_only_from` is empty,
    error-flash to admin: "no deadline to sync yet — use Override".
  - `override-deadline`: parse date, build ISO, call
    `pushReadOnlyFrom`.
- `src/ui/templates/admin/events.tsx`,
  `src/ui/templates/fields.ts`
  - Add `initial_site_months` field to event form. Hidden unless
    `assign_built_site=1` is ticked (existing JS-driven
    conditional-field pattern). Min 1, max 120.
  - Add `months_per_unit` field. Hidden unless `purchase_only=1
    && hidden=1` is ticked (renewal-tier "shape"). Min 1, max 24
    (admin can tier as annual). Help text: "How many months one
    ticket buys. Leave 0 for non-renewal events."
  - In the events list, render a `Renewal` tag next to events with
    `months_per_unit > 0`.
- `src/features/admin/events.ts`
  - `extractCommonFields` / `extractEventUpdateInput` parse the two
    new fields.
  - Validation: when `assign_built_site=1`, reject save unless
    `initial_site_months > 0`. Error message:
    `"Initial site months is required when a site is assigned."`.
  - Validation: when `months_per_unit > 0`, enforce
    `purchase_only=1 && hidden=1` (or surface a soft warning;
    decision: hard enforce so renewal tiers never accidentally
    leak to the public listings).

**Tests**

- `test/templates/admin/built-sites.test.ts`
  - List page renders the formatted deadline column.
  - Detail page shows the renewal URL, tier dropdown, all four
    action buttons.
- `test/admin-built-sites-actions.test.ts` (new)
  - `rotate-renewal-token` issues a new token, pushes a new
    `RENEWAL_URL` to the edge, persists, old token 404s on /renew.
  - `set-renewal-tier` updates the column; rejects non-qualifying
    event IDs.
  - `re-sync-deadline` re-pushes the stored deadline; errors when
    deadline is empty.
  - `override-deadline` accepts a future date, pushes, persists.
- `test/admin-api-events.test.ts`
  - `initial_site_months` round-trips on save.
  - `months_per_unit` round-trips on save.
  - `assign_built_site=1` with `initial_site_months=0` is rejected.
  - `months_per_unit > 0` with `purchase_only=0` is rejected.
- `test/templates/admin/events.test.ts`
  - `Renewal` tag renders for tier events in the admin list.

---

### Phase 7 — Regression + integration

**Files**

- `test/integration/renewals.test.ts` (new)
  - Setup: create a tier event
    (`purchase_only=1, hidden=1, months_per_unit=1, unit_price=500,
    active=1, max_quantity=24`).
  - Create a selling event
    (`assign_built_site=1, initial_site_months=2, unit_price=10000,
    max_quantity=2`).
  - Customer buys 1 selling-event ticket:
    - Stripe-mock-driven webhook → site assigned, renewal token
      generated, `READ_ONLY_FROM = now + 2mo` pushed,
      `RENEWAL_URL` pushed.
  - Customer visits the rendered renewal URL:
    - `GET /renew/?t=<token>` shows the form with site name and
      tier price.
  - Customer POSTs `quantity=3, email=x, name=y`:
    - Stripe checkout created with `items=[{ e: tierId, q: 3,
      p: 1500 }]`, `metadata.site_token = <token>`.
    - Webhook fires → attendee row created → `READ_ONLY_FROM` bumped
      to `now + 2mo + 3mo` (clamped).
    - Stub asserts exact call sequence to
      `bunnyCdnApi.setEdgeScriptSecret`.
  - Buy 2 sites in one checkout (`quantity=2` on selling event):
    - Two independent tokens, two independent
      `setEdgeScriptSecret` calls per site, two distinct
      `RENEWAL_URL` strings.
    - Renewing one site's URL bumps only that site's deadline.
  - Failure path: stub a `setEdgeScriptSecret` rejection on
    `READ_ONLY_FROM` push during renewal → host-side
    `read_only_from` unchanged, activity log records failure,
    "Re-sync deadline" admin POST recovers it.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Bunny secret push silently fails after payment captured | Persist new `read_only_from` only after success; log + ntfy on failure; admin "Re-sync deadline" replays the push. |
| Customer renews on a still-active site → eats their remaining time | `base = max(now, read_only_from)` stacks forward. Tested. |
| Renewal token guessable | 32-byte (256-bit) base64url, generated by `getRandomValues` via existing `generateSecureToken`. Blind-indexed for lookup. |
| Token leaked (URL shared / logged) | Admin "Rotate token" regenerates, pushes new `RENEWAL_URL`, invalidates old URL on next /renew lookup. |
| Site deleted but renewal token row lingers | Existing `DELETE FROM built_sites WHERE id = ?` removes the row entirely. No FK on the tier event → no cascade needed. Renewal payments to that site (if a checkout was in flight at delete-time) will 404 in `applyRenewalsForEntries`'s "site not found" branch — log only. |
| Tier event deleted while customers have it assigned | `applyRenewalsForEntries` sees `event.id === site.renewalTierEventId` is false (deleted event isn't in the attendee→event list); admin should reassign tier before deleting. Phase 6 admin event-delete guard could enforce: "this event is the renewal tier for N sites; reassign first." Optional; logging is the floor. |
| Admin accidentally publishes a renewal tier event | `months_per_unit > 0` requires `purchase_only=1 && hidden=1` on save (Phase 6 validation). |
| Admin sets `months_per_unit` on a non-tier event by accident | Same form validation: the field is gated on the tier "shape". Defensive `pickTierEvent` only matches the full predicate. |
| Site assignment runs with zero tier events | Assignment aborts cleanly per-entry, logs + ntfy. Customer payment captured → admin support ticket → create tier event → click "Re-sync deadline" (which would need to also generate the missing token and pick a tier — alternative: a one-off admin "Provision renewal for this site" button). |
| Malformed `READ_ONLY_FROM` locks customer out | Fail open: invalid value treated as "no cutoff", logged. |
| Clock skew between host and edge | Both run on Bunny's infra; ms-level skew is irrelevant at month granularity. |
| `initial_site_months=0` on a paid built-site sale | Form rejects on save; assignment defensively re-checks and skips on 0 (API-bypass). |
| Refund issued for a renewal | Out of scope for v1: customer keeps paid-for time, refund returns money only. Document. |
| Multi-site checkout with one push failure | Each site processed independently; failures leave that site's host-side date unchanged. No rollback of others. |
| `site_token` rotated between checkout creation and webhook arrival | `applyRenewalsForEntries` lookup misses → logged, no bump. Customer paid for time that didn't apply. Rare (rotation is manual + minutes apart); admin "Re-sync" + manual override is the recovery. |
| Renewal flow goes through attendee/PII pipeline → row per renewal | Acceptable: ~12 rows/year per active site. Existing `processed_payments` pruning leaves attendee rows in place; that's fine for audit. |
| `SessionMetadata` is a strict shape; adding `site_token` touches every provider extractor | One-line addition in `extractSessionMetadata` + one in `buildMetadata`; both Stripe and Square pick up the change via the shared helper. |

## File-change summary

| Area | Files | Notes |
|---|---|---|
| Schema | `migrations.ts`, `events.ts` (db), `built-sites.ts`, `types.ts` | 5 new columns + blob v2 |
| Read-only semantics | `env.ts`, banner CSS | `isReadOnly`, `isReadOnlyWarning`, `getReadOnlyCutoffIso`, `getRenewalUrl`, pure helpers |
| Banner UI | `templates/admin/nav.tsx`, `templates/public.tsx` | Pre-expiry warning + read-only banner both deep-link to `RENEWAL_URL` |
| Builder | `builder.ts` | Pass `READ_ONLY_FROM`, `RENEWAL_URL`, `READ_ONLY_WARN_DAYS` secrets |
| Assignment | `site-assignment.ts` | `pickTierEvent`, `generateRenewalToken`, `pushReadOnlyFrom`, tier-event guard |
| Renewal route | new `features/public/renewal.ts`, new `templates/public/renewal.tsx`, `features/index.ts` | GET + POST handlers, form template, dispatch wiring |
| Payment metadata | `payments.ts`, `payment-helpers.ts`, `features/api/webhooks.ts` | Optional `site_token` everywhere |
| Webhook side-effect | `webhook.ts` | `applyRenewalsForEntries` |
| Date math | new `dates.ts` | `addMonthsIso` (clamped) |
| Admin events form | `fields.ts`, `templates/admin/events.tsx`, `features/admin/events.ts` | Two new fields, two new validations, Renewal tag |
| Admin built-sites surface | `templates/admin/built-sites.tsx`, `features/admin/built-sites.ts` | Deadline column, renewal panel, 4 action POST routes |
| Tests | ~9 test files | All additive |

Roughly **13–15 source files**, **8–10 test files**.

## Resolved decisions

1. **Renewal events:** shared tier events in `events` table, **not**
   per-site rows. Each site holds a column pointing at its current
   tier event.
2. **Identification:** 32-byte random renewal token per site
   (`generateSecureToken`), HMAC blind index for lookup. Matches
   existing `ticket_token` / `ticket_token_index` pattern.
3. **Renewal URL:** `/renew/?t=<token>` — dedicated route, not the
   public event page.
4. **Tier coupling:** `built_sites.renewal_tier_event_id` (column).
   Tier change is a single `UPDATE` with no URL rotation needed.
   Token rotation and tier change are independent operations.
5. **Default tier picking at assignment:** pick the cheapest
   qualifying tier event (`purchase_only=1, hidden=1,
   months_per_unit > 0, active=1`). No env var. No new setting.
6. **Tier-must-exist guard:** assignment aborts cleanly per-entry
   when no qualifying tier event exists; logs `CONFIG_MISSING` +
   ntfy.
7. **Initial deadline:** new `events.initial_site_months`, required
   > 0 when `assign_built_site=1`.
8. **Expiry behaviour:** full read-only at `READ_ONLY_FROM`. Warning
   banner shown `READ_ONLY_WARN_DAYS` days before (env var, integer,
   default 14). Both banners deep-link to `RENEWAL_URL`.
9. **Public-facing warning:** v1 is **admin-only**. Public visitors
   don't see the pre-expiry warning.
10. **Renewal events in admin events list:** mixed in with a
    `Renewal` tag. `months_per_unit > 0` enforces
    `purchase_only=1 && hidden=1`.
11. **Refunds:** out of scope for v1.
12. **Multi-site purchases (qty > 1):** each site gets its own
    token + URL + independent secrets push.
13. **Month arithmetic:** `addMonthsIso` clamps to last day of the
    target month.
14. **Push failure after renewal payment:** don't advance host-side
    date, log + ntfy. Recover via admin "Re-sync deadline".
15. **Payment-pipeline reuse:** renewals run through the existing
    attendee/PII/webhook pipeline. One attendee row per renewal acts
    as the audit trail. New optional `site_token` field on
    `SessionMetadata` carries which site is renewing.
16. **Bunny secret propagation:** confirmed — `setEdgeScriptSecret`
    propagates without republish. No `publishEdgeScript` call in
    `pushReadOnlyFrom`.

## Still to confirm

1. **libsql partial unique index for empty-string token index.**
   If `idx_built_sites_renewal_token_index UNIQUE` blocks pre-Phase-3
   rows (all `''`), use a `WHERE renewal_token_index != ''` partial
   index or drop the unique constraint and rely on application-layer
   uniqueness (tokens are 32 random bytes — collision probability is
   negligible).
2. **"Provision renewal for legacy site" admin button.** Sites that
   existed pre-Phase-1 will have empty `renewal_token_index` and
   `renewal_tier_event_id`. Phase 6's "Re-sync deadline" needs a
   sibling action that *initialises* the renewal state for a legacy
   site (generate token + pick tier + compute initial cutoff from
   admin input + push). Worth adding to Phase 6.
3. **Square's session metadata field-length limit (255).** The
   `site_token` is ~43 chars (32 bytes base64url) — well under the
   limit but worth a one-line check in the existing
   `enforceMetadataLimits` to be future-proof.
4. **Phase 8 (out of scope but obvious next):** cron over
   `built_sites` whose `read_only_from ∈ [now, now +
   READ_ONLY_WARN_DAYS]` and send a renewal-nudge email. Land after
   v1 ships.
