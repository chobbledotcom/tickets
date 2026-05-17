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

When the customer first buys a built site (an `assign_built_site=1`
event, today's flow), we need to:

1. Decide the initial number of free months. Options considered:
   - **Reuse `events.max_quantity`** — overloads meaning ("max tickets
     per booking" already), confusing.
   - **Add a new column `initial_months` on the source event** —
     clean, explicit. `assign_built_site=1` events get a number-of-
     months input next to the existing site-builder fields.
   - Hard-code (e.g. always 1 month) — too inflexible.

   **Decision:** new column **`events.initial_site_months INTEGER NOT
   NULL DEFAULT 0`**. Admin-editable, only meaningful when
   `assign_built_site=1`. Zero means "no deadline set" (existing
   behaviour preserved).

2. On assignment, compute `READ_ONLY_FROM = now() + initial_site_months
   months`. Push it to the built site's edge script as a secret.

3. Create the per-site renewal event (see flow below) and push its
   public URL to the edge script as `RENEWAL_URL`.

### Coupling renewal events to sites

- **One renewal event per built site**, created at assignment time
  (the moment `assignBuiltSite` is called).
- Renewal event defaults (admin can edit later):
  - `name`: `"Renew <site name>"`
  - `slug`: auto-generated unique slug (existing `generateUniqueSlug`).
  - `hidden=1, purchase_only=1, assign_built_site=0`.
  - `unit_price = renewalPrice` (new admin setting; or copied from the
    source event — see open question).
  - `months_per_unit = 1`.
  - `max_quantity = 24` (cap, admin-tunable).
  - `can_pay_more=0`, `non_transferable=1`.
  - `renewal_for_site_id = <built_site.id>`.
- The slug is **not** secret. It's discoverable via the assigned
  built site (the URL is stored as `RENEWAL_URL` on its edge script,
  which only the site owner / their site can access). `hidden=1` keeps
  it off the public listing and adds `x-robots-noindex`. If we want a
  belt-and-braces secret, lengthen `generateSlug` for renewal events
  only — see open question.

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
  - A manual "Push deadline now" button that re-syncs
    `READ_ONLY_FROM` from the host's stored value to the edge script
    (recovery tool when a Bunny call fails silently).
  - A "Set deadline" form for support overrides (host operator only).
    Writes the host-side value and pushes to the edge script.
- Source events (the ones that *sell* sites, `assign_built_site=1`)
  get an `initial_site_months` field in the event form.

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

### Phase 2 — Built site read-only-from semantics

This is the customer-facing payoff: even with no renewal flow wired up,
a site with `READ_ONLY_FROM` set in the past becomes read-only on its
own.

**Files**

- `src/shared/env.ts` — replace `isReadOnly` body with the helper
  shown above (force-override + date-based cutoff). Add a tiny pure
  helper `isReadOnlyFromCutoff(now: number, cutoff: string | undefined)`
  to keep the date math testable without env mocking.
- `src/shared/logger.ts` — no new error codes needed; reuse
  `ErrorCode.DATA_INVALID` for malformed `READ_ONLY_FROM`.
- `src/ui/templates/admin/nav.tsx`, `src/ui/templates/public.tsx`,
  `src/features/index.ts` — no source changes; they all use
  `isReadOnly()`.

**Tests**

- `test/lib/env.test.ts`
  - `READ_ONLY=true` ⇒ read-only regardless of date.
  - `READ_ONLY_FROM` in the past ⇒ read-only.
  - `READ_ONLY_FROM` in the future ⇒ writable.
  - `READ_ONLY_FROM` unset ⇒ writable.
  - `READ_ONLY_FROM` malformed ⇒ writable (fail open), logs error.
- `test/routes/read-only.test.ts` — existing read-only-mode page
  rendering still triggers when `READ_ONLY_FROM` is in the past.

---

### Phase 3 — Initial deadline at site assignment

**Files**

- `src/shared/builder.ts`
  - Extend `BuildSiteInput` with optional `readOnlyFrom?: string` and
    `renewalUrl?: string`.
  - Push them into the secrets array when set:
    `["READ_ONLY_FROM", readOnlyFrom]`, `["RENEWAL_URL", renewalUrl]`.
  - `BuildSiteResult` doesn't need to change (we already know the
    scriptId on the host).
- `src/shared/site-assignment.ts`
  - `assignSitesForEntries`: after `assignBuiltSite`, before the email,
    compute the initial cutoff from `event.initial_site_months`
    (zero ⇒ leave blank, no deadline). Push it to the script via
    `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId,
    "READ_ONLY_FROM", cutoffIso)` and persist to
    `built_sites.read_only_from`.
  - Create the per-site renewal event here (see Phase 4 helper).
    Then push `RENEWAL_URL = https://<host>/<renewalSlug>` to the
    script as a secret.
- `src/shared/now.ts` already exports `nowIso()`; add a tiny pure
  helper there (or in a new `src/shared/dates.ts` if cleaner)
  `addMonthsIso(fromIso: string, months: number): string` using
  `Date.UTC` with month overflow (e.g. Jan 31 + 1mo = Feb 28/29).

**Tests**

- `test/lib/dates.test.ts` (or `now.test.ts`) — `addMonthsIso` covers:
  end-of-month overflow, negative months, leap years, zero months
  (returns the input).
- `test/lib/site-assignment.test.ts` (new or existing)
  - With `event.initial_site_months = 3`, assignment pushes
    `READ_ONLY_FROM` = now + 3 months to the script and persists
    the value to `built_sites.read_only_from`.
  - With `initial_site_months = 0`, no `READ_ONLY_FROM` secret is set.
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

- `src/shared/webhook.ts`
  - New `applyRenewalsForEntries(entries)` helper, mirroring
    `assignAndNotifyBuiltSites`:
    - Filter entries to those whose event has
      `renewal_for_site_id != null`.
    - For each: load the site, compute the new deadline (base =
      `max(now, site.read_only_from)` so back-to-back renewals stack
      forward rather than overlapping), call
      `bunnyCdnApi.setEdgeScriptSecret(site.bunnyScriptId,
      "READ_ONLY_FROM", newIso)`, then persist via
      `builtSitesTable.update`.
    - Log via `logActivity` ("Renewal of '<site name>' for N months").
  - In `logAndNotifyRegistration`, add
    `addPendingWork(applyRenewalsForEntries(entries))` next to the
    existing pending-work calls.
- `src/shared/site-assignment.ts` — extract a small
  `pushReadOnlyFrom(site, cutoffIso)` helper used by both
  Phase 3 (initial) and Phase 5 (renewal) to centralise the
  setEdgeScriptSecret + DB persist.

**Tests**

- `test/lib/renewals.test.ts` (new)
  - Renewal for 3 months: site with `read_only_from` 10 days from now
    becomes `now + 10d + 3 months`.
  - Expired site (`read_only_from` in the past): renewal makes it
    `now + N months` (not past + N).
  - Quantity multiplies by `months_per_unit` (set
    `months_per_unit=3`, qty=2 ⇒ +6 months).
  - Stripe webhook stub fires through to
    `bunnyCdnApi.setEdgeScriptSecret` exactly once.
  - Entry without `renewal_for_site_id` is ignored.

---

### Phase 6 — Admin surfaces & quality of life

**Files**

- `src/ui/templates/admin/built-sites.tsx` (or wherever the list lives
  — likely a generic CRUD template; search for `builtSitesCrudTable`)
  - Show `read_only_from` per row (formatted, "never", "expired",
    "in N days").
- Per-site detail view:
  - Link to the renewal event.
  - Button: "Re-sync deadline" (re-POSTs the persisted value to the
    edge script — recovery path if a Bunny push failed).
  - Manual override form: pick a date, push it to the site.
- Source event admin form (`src/ui/templates/fields.ts`,
  `src/ui/templates/admin/events.tsx`):
  - Add `initial_site_months` field, only shown when
    `assign_built_site=1`. Help text: "Months of access granted on
    initial purchase. The customer can renew later for more time."
- Renewal event admin form:
  - Show `months_per_unit` and the linked-site context as a banner
    rather than free-form fields.

**Tests**

- `test/templates/admin/built-sites.test.ts` — formatted deadline
  appears, override form posts to the expected route.
- `test/admin-api-events.test.ts` — `initial_site_months` round-trips
  on edit/save.

---

### Phase 7 — Regression + integration

**Files**

- `test/integration/*` — one end-to-end test:
  1. Admin creates a paid event with `assign_built_site=1`,
     `initial_site_months=2`.
  2. Customer pays → site is assigned, renewal event is created,
     `READ_ONLY_FROM = now + 2 months` is recorded.
  3. Customer visits `RENEWAL_URL`, pays for `quantity=3` →
     `READ_ONLY_FROM` advances by 3 months.
  4. Stub `bunnyCdnApi.setEdgeScriptSecret` to assert the exact value
     pushed at each step.
- Bunny API failure path: simulate a `setEdgeScriptSecret` error and
  assert the host-side `built_sites.read_only_from` is **not** advanced
  (so the customer doesn't pay for time that never landed on the
  edge). Pair with a retry / admin "re-sync" button (Phase 6).

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
| `initial_site_months=0` on a paid built-site sale | Treated as "no deadline" — preserves today's behaviour for installs that don't want monthly billing. |

## File-change summary (estimated)

| Area | Files | Notes |
|---|---|---|
| Schema | `migrations.ts`, `events.ts` (db), `built-sites.ts`, `types.ts` | 4 new columns + blob v2 |
| Read-only semantics | `env.ts` | One function, ~10 lines |
| Builder | `builder.ts`, `bunny-cdn.ts` (no change) | Pass two new secrets through |
| Assignment + renewal create | `site-assignment.ts`, `webhook.ts` | Hook in `pushReadOnlyFrom`, `applyRenewalsForEntries` |
| Date math | `now.ts` or new `dates.ts` | `addMonthsIso` |
| Admin UI | `fields.ts`, `templates/admin/events.tsx`, `templates/admin/built-sites.tsx` | Two new form fields + a deadline column + override form |
| Tests | ~6 test files | All additive |

Roughly **9–11 source files**, **5–7 test files**.

## Open questions

1. **Renewal pricing source.** Three options:
   - Copy `unit_price` from the source event at assignment time.
   - New per-source-event field `renewal_unit_price`.
   - Global setting (`settings.renewalUnitPrice`).
   Recommend the per-source-event field so different "tiers" can sell
   the same site with different monthly fees. Defaults to source
   event's `unit_price` if unset.
2. **Republish requirement.** Confirm Bunny edge scripts pick up
   secret changes without a `publishEdgeScript` call. If not, fold
   a publish into `pushReadOnlyFrom` (cheap, idempotent).
3. **Slug length for renewal events.** Default 5-char slug from
   `generateSlug` (~1.15M space) plus `hidden=1` is probably fine
   because the URL is only ever shared with the owner. Worth a quick
   `Should we bump to e.g. 12 chars only for renewal events?` decision
   before Phase 4.
4. **Notification before expiry.** Out of scope for v1 but the next
   obvious feature: cron over `built_sites` rows with
   `read_only_from` between `now + 7d` and `now + 14d`, send email
   nudging the customer to the `RENEWAL_URL`. Could land as Phase 8.
5. **What does the built site itself show on the read-only banner?**
   Today's banner just says "This site is in read-only mode". We
   could plumb `RENEWAL_URL` through and turn it into a "Renew now"
   link. Tiny UX win, big customer-facing value. Worth doing in
   Phase 6 if `RENEWAL_URL` is wired through to the env at that
   point.
