# Entity pages: one schema-driven, tabbed framework for every admin "edit X" page

## Summary

Every rich admin edit page — attendee, listing, modifier, group, user, … — is
assembled from the same handful of parts: a read-only summary of the item, one
big edit form (with sections hidden by your selections), an embedded ledger
panel, an activity log, system notes, a delete flow, a row of other actions,
internal links to related items, and external links to third-party services.
Today each page hand-assembles those parts in its own order, in its own
1,000–2,600-line template, with its own routing quirks and its own mix of
`t()` and hardcoded English.

This plan introduces **entity pages**: one declarative schema
(`defineEntityPage`) that describes an entity's page as **a list of tabs, each
an ordered list of typed sections**, plus one shared renderer and one generated
route surface. The section kinds (summary, form, ledger, activity, notes,
actions, links, danger zone) are a closed discriminated union rendered through
an exhaustive `Record` — the "guide sections" pattern
(`src/ui/templates/admin/guide/components.tsx`) scaled up to whole pages. A
tabbed layout replaces both "one giant scrolling page" (attendees) and "detail
page + separate edit page" (listings) without adding anything to the admin nav.

Migration is gradual, hardest first: **attendees**, then **listings**, then the
remaining collections one PR at a time.

This document is the plan. Where it names concrete files/lines they are the
code the work builds on, verified against the tree at the time of writing.

---

## Implementation status

**Slice 1 — framework + attendees — ✅ built & green.** Where this plan and
the code differ, the code wins:

- `src/shared/entity-pages/core.ts` — the pure core (tab resolution, strip
  building, path minting, action splitting).
- `src/features/admin/entity-pages.ts` — `defineEntityPage<E, Id>` (the
  shell): guard → load → resolve tab → load ONLY the active tab's sections →
  render. Ids are generic (`number | string`) so `/admin/history/:hmac` can
  migrate. Exposes `renderPage(session, id, slug, { status, sections })` for
  in-place failure re-renders.
- `src/ui/templates/admin/entity-pages.tsx` — the renderer: page shell,
  tab strip (links + `aria-current`), exhaustive `SECTION_RENDERERS`.
- `src/features/admin/attendee-page.ts` + `attendee-page-data.ts` +
  `src/ui/templates/admin/attendee-page.tsx` — the attendee page:
  Overview / Edit / Ledger (owner-only) / Activity / Actions, banner =
  status + notes on every tab.

**Review resolutions baked in (Codex):** route keys stay literal (handlers,
not generated keys); per-tab `visible` IS authorization (hidden tab 404s,
role-aware default tab); Ledger stays owner-only; ids generic for history;
refund POSTs honor `return_url`; summary rows conditional by construction;
i18n enforced by the coverage ratchet + render assertions; and **failure
feedback is an in-place 400 through the framework renderer, never a
stash-dependent PRG bounce** (the section below reflects this).

**Divergences from the sketch, deliberate:** no separate `form`/`notes`
section kinds yet — with no framework behavior of their own they'd duplicate
`custom` (the Edit tab and the notes banner are `custom`/banner content);
they become kinds when a second entity gives them shared behavior. The
`EntityFormAdapter` shrank to "render the form" for the same reason.

**Not yet built:** slices 2+ (listings, modifiers, the rest) — the
forward-looking guidance below still applies.

---

## The current state (what we're unifying)

The two hardest pages, mapped:

- **Attendee** — `GET/POST /admin/attendees/:attendeeId`
  (`src/features/admin/attendees.ts:358-370`, handlers in
  `attendee-form-routes.ts`, 974 lines). One page renders *everything*, top to
  bottom: system notes, warnings, summary table, bookings table, answers,
  payment details, action links, a collapsed `<details>` log, a collapsed
  owner-only ledger, then the edit form itself inside another `<details>`,
  contact history, and a merge form (`src/ui/templates/admin/attendee-form.tsx`,
  972 lines — composition at `:890-970`). The form is **not** on the
  `defineForm` rails — it has a bespoke model (`attendee-form-model.ts`) for
  the per-listing quantity table and shared dates. Sub-actions are scattered
  across six feature files (notes in `attendee-notes.ts`, refunds in
  `attendee-refunds.ts`, delete/resend under
  `/admin/listing/:listingId/attendee/:attendeeId/*` in `actions.ts`, merge in
  `attendees-merge.ts`, ledger in `ledger.ts`, refresh-payment in
  `attendees-edit.ts`). Every GET loads and decrypts *all* of it — log (limit
  1000), ledger, notes, history — even when the operator only came to fix a
  typo in the name.
- **Listing** — a **detail** page (`GET /admin/listing/:id`,
  `adminListingPage`, `src/ui/templates/admin/listings.tsx:1332`) *and* a
  separate **edit** page (`GET/POST /admin/listing/:id/edit`,
  `adminListingEditPage`, `listings.tsx:2362-2489`; handlers in
  `listings-edit.ts`). The detail page carries the summary table, action nav
  (`ListingActionNav`, `listings.tsx:546`), attendee list, income
  reconciliation, and embedded ledger (`ListingLedgerSection`,
  `listings.tsx:478`); the edit page carries the sectioned form
  (`ListingFormSections`, `listings.tsx:1972`), running totals, an income
  adjustment form, image/attachment delete forms, and the required-children
  editor. One 2,604-line template file holds both plus the create, duplicate,
  picker, and three confirm pages.

They are the same page wearing two different hand-made outfits. The modifier
edit page (`src/ui/templates/admin/modifiers.tsx:386-424`) is a third copy of
the same composition — money adjust + running totals + ledger + links + delete.

**What already exists to build on** (all verified):

- **Composable section components**: `AccountStatementSection`
  (`src/ui/templates/admin/ledger.tsx:615` — account + lines + names +
  returnUrl, reused today by both the standalone statement page and the
  attendee panel), `ActivityLogTable` (+ `ActivityLogRefs`,
  `src/ui/templates/admin/activityLog.tsx:41,121`), `AttendeeNotesSection`,
  `ConfirmForm`, `Flash`, `CsrfForm`.
- **Schema-driven forms**: `defineForm` (`src/shared/forms.tsx:449`) with
  typed `FormValuesFor<>`, and the route factories `createAuthedHandler` /
  `createAuthedFormRoute` (`src/shared/app-forms.ts:52,111`).
- **PRG flash**: `redirect(url, message, succeeded, {formId})`
  (`src/features/response.ts:167`) + `applyFlash` + the `Layout` backstop
  (`src/ui/templates/layout.tsx:89`) + `CsrfForm`'s targeted inline flash.
  Success/error already lands next to the right form on the right page.
- **CSS-only conditional visibility**: the `:has()` mixins
  (`reveal-when-checked`, `reveal-when-selected`, `hide-when-using-defaults`,
  `src/ui/static/style.scss:1626-1656`) — the show/hide-by-selection behaviour
  needs no JS and survives the move into tabs unchanged.
- **The schema exemplars**: `GuideSection[]` + `renderGuideSections`, and the
  admin nav's "one schema → desktop DOM + mobile DOM" pattern
  (`src/ui/templates/admin/nav.tsx:93,178`).
- **No tab UI exists anywhere yet** — this is greenfield, so we get to define
  the one convention.

---

## The concept: a page is data

One declaration per entity, in the entity's feature area:

```ts
// src/shared/entity-pages/types.ts — plain types, no imports beyond domain types

/** One row of the read-only summary table. `href` renders the value as an
 *  internal link; `external` as target=_blank; neither ⇒ plain text.
 *  Conditional rows are handled by CONSTRUCTION, not a visible flag: the
 *  section's `rows(e, ctx)` builder is the one place rows are minted, and it
 *  simply doesn't emit a row (or emits it unlinked) when the viewer can't
 *  follow it — same compact()-over-nullable shape as the existing
 *  AttendeeDetail. "Never render a forbidden link" is enforced where the
 *  link is built, against the same condition the target enforces. */
export interface SummaryRow {
  labelKey: string;                 // locale key, e.g. "entity.attendee.summary.email"
  value: string | JSX.Element;
  href?: string;
  external?: boolean;
}

/** An operator action. Renders as a link (GET confirm pages) or a one-click
 *  CSRF POST button. `visible` gates on the SAME condition the target route
 *  enforces — a forbidden action is never rendered. */
export interface ActionDef<E> {
  labelKey: string;
  descriptionKey?: string;          // one-line explanation under the label
  href: (e: E, ctx: PageCtx) => string;
  method?: "get" | "post";          // default "get"
  visible?: (e: E, ctx: PageCtx) => boolean;
  danger?: boolean;                 // renders in the danger zone styling
}

export interface PageCtx {
  session: AdminSession;
  returnUrl: string;                // the canonical URL of the current tab
}

/** The closed union of section kinds. Adding a kind is a compile error in
 *  the renderer Record and the loader Record until both arms exist. */
export type Section<E> =
  | { kind: "summary"; rows: (e: E, ctx: PageCtx) => SummaryRow[] }
  | { kind: "form";
      form: EntityFormAdapter<E> }                 // see "The form section"
  | { kind: "ledger";
      account: (e: E) => AccountRef;
      visible?: (e: E, ctx: PageCtx) => boolean }  // e.g. owner-only
  | { kind: "activity";
      load: (e: E) => Promise<ActivityLogEntry[]>;
      refs?: (e: E) => Promise<ActivityLogRefs> }
  | { kind: "notes";
      load: (e: E) => Promise<SystemNote[]>;
      addHref: (e: E, ctx: PageCtx) => string }
  | { kind: "actions"; actions: readonly ActionDef<E>[] }
  | { kind: "custom";                              // the bounded escape hatch
      load: (e: E, ctx: PageCtx) => Promise<JSX.Element> };

export interface TabDef<E> {
  slug: string;                     // URL segment; "" for the default tab
  labelKey: string;                 // "entity.tab.overview", "entity.tab.edit", …
  sections: readonly Section<E>[];
  visible?: (e: E, ctx: PageCtx) => boolean;   // role/feature-gated tabs
}

export interface EntityPageDef<E> {
  key: string;                      // "attendee" | "listing" | …
  basePath: (id: Id) => string;     // "/admin/attendees/5" — URL minting only.
                                    // Id is generic (number | string): numeric
                                    // rows use number; /admin/history/:hmac's
                                    // blind-index token migrates as a string id
  titleOf: (e: E) => string;        // page <h1> / <title>
  navActive: string;                // passed to AdminNav
  auth: PageAuth;                   // GET guard, per existing authPage guards
  load: (id: number, session: AdminSession) => Promise<E | null>; // null ⇒ 404
  banner?: (e: E, ctx: PageCtx) => Promise<JSX.Element | null>;
                                    // always-visible alerts above the tabs:
                                    // system-note warnings, payment warnings
  tabs: readonly TabDef<E>[];
}
```

`defineEntityPage(def)` returns **handlers, not route keys**: a
`renderTab(request, id, tabSlug)` the feature file binds under its own
literal route strings —

```ts
"GET /admin/attendees/:attendeeId": (request, { attendeeId }) =>
  attendeePage.renderTab(request, attendeeId, ""),
"GET /admin/attendees/:attendeeId/:tab": (request, { attendeeId, tab }) =>
  attendeePage.renderTab(request, attendeeId, tab),
```

The typed router (`defineRoutes`, `src/features/router.ts`) infers param
types from **literal** route-string keys, so route keys cannot be minted from
a runtime schema anyway; `basePath` exists only to build concrete URLs
(`tabPath` composes on it), never patterns. The two-line binding per entity
is the whole wiring cost. POST handlers stay where they are today — they are
feature logic — but redirect to tab paths via the framework's one path helper
(below).

**Per-tab authorization.** Page-level `auth` is the *floor* — the weakest
role that may see any part of the page — and `TabDef.visible` gates each tab
on the *same condition its content requires*, evaluated server-side before
render (a hidden tab both disappears from the strip and 404s when named
directly, so visibility IS authorization here, not decoration). This matters
for split-permission entities: today the listing/group *detail* GETs are
staff-only (attendee PII, money) while their `/edit` GETs are content-gated
so editors can change copy. Migrated, the page floor is the content guard,
the Overview/Activity tabs carry staff-only `visible` predicates (Ledger
stays owner-only — it exposes the money ledger, matching `/admin/ledger*`), and
the **default tab is role-aware**: `GET {base}/:id` renders the first tab
visible to the viewer (an editor lands on Edit; staff land on Overview) —
never a 403 on the bare URL, never a forbidden tab in the strip.

### Why a closed union, not plugin objects

Per "shared interfaces over branch-per-case" (AGENTS.md): the renderer is one
exhaustive `Record<Section["kind"], SectionRenderer>` and the per-tab data
loader is its sibling `Record`. Forgetting to handle a kind is a compile
error, not a blank region. The `custom` kind is the pressure valve for the
genuinely bespoke (the attendee merge form, the listing children editor) — but
it still lives *inside* a tab, gets the tab's loading/ctx/returnUrl for free,
and is pushed through the same styling, so "custom" means "custom content",
never "custom page shape".

### The three rings (same shape as the site-pages plan)

- **Pure core** (`src/shared/entity-pages/core.ts`): tab resolution
  (`resolveTab(def, e, ctx, slug)` → active tab or null-for-404), visible-tab
  filtering, `tabPath(def, id, slug)` (the one place tab URLs are minted),
  summary-row and action filtering. Plain data in, plain data out — this is
  where the table-driven tests live.
- **Impure shell** (`src/shared/entity-pages/routes.ts`): the generated GET
  handler — auth guard → `def.load` (null → `notFoundResponse()`) →
  `applyFlash` → run **only the active tab's** section loaders (plus
  `def.banner`) → hand plain view data to the renderer.
- **Renderer** (`src/ui/templates/admin/entity-pages/render.tsx`): the page
  shell (title, banner region, tab strip, sections) and the
  `SECTION_RENDERERS` Record. Pure `data → JSX`, unit-testable with fixtures.

**Per-tab loading is a cold-start win, not just tidiness.** Today
`handleAttendeeEditGet` loads and decrypts the 1000-entry activity log, the
full ledger statement, the notes, and the contact history on *every* view.
Under the framework, the Ledger tab's loader runs only when the Ledger tab is
the active one. The edge subrequest budget (AGENTS.md "Built for cold starts")
gets strictly lighter on every migrated page.

---

## URLs, tabs, and landing in the right place

### Path shape

Tabs are **path segments**, not query params or client-side state:

```
/admin/attendees/5            → default tab (Overview)
/admin/attendees/5/edit       → Edit tab
/admin/attendees/5/ledger     → Ledger tab
/admin/attendees/5/activity   → Activity tab
/admin/attendees/5/actions    → Actions tab
```

Why paths: they're deep-linkable, they work with the existing PRG machinery
unchanged (`redirect("/admin/attendees/5/ledger", "Ledger entry added", true)`
lands the operator on the tab that owns the result), the browser back button
does the right thing, and `return_url` threading through sub-actions
(notes/refunds/ledger edits) keeps working verbatim — the return URL is simply
the tab's canonical URL, which `PageCtx.returnUrl` supplies so no config ever
hand-builds one.

An unknown tab slug 404s (`notFoundResponse()`), same as an unknown id. A tab
whose `visible` is false for the current viewer also 404s — the strip never
rendered it (never render a forbidden link), so nothing links there.

**Slug collisions**: tab slugs share the `{base}/:id/…` namespace with
existing action routes (`/merge`, `/balance`, `/refresh-payment` on attendees;
`/delete`, `/duplicate`, `/income` on listings). Literal route segments beat
`:tab` in the router's specificity ordering (`src/features/router.ts` sorts
literals ahead of params), so existing action routes keep winning — but keep
tab slugs out of that vocabulary anyway. The standard set: `edit`, `ledger`,
`activity`, `actions` (and `""` for overview). `log` is deliberately avoided:
`/admin/listing/:id/log` already exists and will 301 to `…/activity` when
listings migrate.

### The standard tab set

The framework doesn't hardcode which tabs exist — the schema does — but the
convention every entity follows unless it has a reason not to:

| Tab (slug) | Contents (section kinds) |
| --- | --- |
| **Overview** (``""``) | `summary` rows (the most-useful info, incl. internal + external links) · `notes` · a short `activity` preview (last N entries + "view all" into the Activity tab) · contextual `custom` panels (attendee bookings table, listing attendee list) |
| **Edit** (`edit`) | the `form` section (one big form, CSS-`:has()` conditional visibility intact) |
| **Ledger** (`ledger`) | `ledger` section — `AccountStatementSection` with add/click-to-edit, exactly as embedded today, `returnUrl` = this tab |
| **Activity** (`activity`) | `activity` section — the full `ActivityLogTable`, no longer buried in a collapsed `<details>` |
| **Actions** (`actions`) | `actions` sections: the plain actions first (resend, refund, duplicate, scanner, QR, email…), then the **danger zone** (`danger: true` actions — deactivate, delete) visually separated at the bottom |

This answers two of the stated pain points directly: **logs become a
first-class tab** (visible, not a collapsed afterthought, plus a preview on
Overview), and **actions feel integrated** (one consistent, described,
role-filtered list instead of a floating row of links) while delete stays
deliberately last and visually distinct.

### Default tab

Overview — the read-only summary — is the default landing for
`GET {base}/:id`. Rationale: it's the safe, fast page (no form state to
clobber), it's what every internal link to the entity means today
("show me this attendee"), and it's where the notes/warnings live. Saving the
edit form redirects back to **the Edit tab** with the success flash
(`redirect(tabPath(def, id, "edit"), "Updated …", true)`) — you land where you
acted, with your context intact.

### Banner region (always visible)

Some things must not hide behind a tab: the flash message, **system-note
alerts** (the red boxes on the attendee page), and hard warnings (payment
mismatch, capacity). `def.banner` renders above the tab strip on **every**
tab. The full notes UI (list, add, delete) lives on Overview; the banner shows
only the alert-worthy subset. The `Layout` flash backstop continues to catch
anything a tab didn't render inline.

---

## The form section (the hard part, faced honestly)

Two form styles exist and both must ride the same rails:

1. **`defineForm` forms** (listings after migration, modifiers, holidays…):
   a `Field[]` schema that renders and validates itself.
2. **Bespoke forms** (the attendee multi-line quantity table + shared dates):
   hand-rolled parse/validate that will never fit `Field[]`.

The framework doesn't pretend they're the same thing; it defines the one
narrow interface both satisfy:

```ts
export interface EntityFormAdapter<E> {
  formId: string;                                   // flash targeting anchor
  render: (e: E, ctx: PageCtx) => Promise<JSX.Element>; // the <CsrfForm …>
  // POST stays a normal route; the adapter just tells the framework where:
  action: (e: E) => string;                         // form action URL
}
```

- A `defineForm`-backed entity gets a one-line adapter via a provided helper
  (`formSectionFor(definition, values)`), and its POST handler is a stock
  `createAuthedFormRoute` whose `onValid` ends in
  `redirect(tabPath(def, id, "edit"), msg, true, { formId })` and whose
  `onInvalid` is `errorRedirect(tabPath(…), error, formId)` — the saved-form
  stash re-fills values after the bounce, as everywhere else.
- The attendee form keeps `attendee-form-model.ts` (its parse/validate is
  domain logic worth keeping) but its **render** moves inside the Edit tab and
  its POST redirects/re-renders against tab URLs. Migrating the attendee page
  does **not** require rewriting the quantity-table model — that's what makes
  the migration tractable.

**Failure feedback: in-place 400 through the framework renderer — never a
stash dependency.** An earlier draft replaced the attendee page's in-place
validation re-render with PRG plus a validation replay from the saved-form
stash. That replay is not correctness-preserving: the stash
(`src/shared/form-stash.ts`) is explicitly a warm-isolate optimisation — a
cold or different edge isolate, expiry, eviction, or an over-size form all
miss, and the operator's entered values and per-line errors would be lost.
So the framework keeps the split the codebase's hardest pages already use
(`renderListingEditError`, `listings-edit.ts:384` renders at HTTP 400):

- **Success → PRG.** `redirect(entityPage.path(id, "edit"), msg, true,
  { formId })` — flash on the tab that owns the form.
- **Validation/save failure → render the SAME tab page in place at 400.**
  `defineEntityPage` exposes `renderPage(session, id, slug, { status,
  sections })` — the identical shell (banner, strip, nav) with the failing
  tab's sections overridden to carry the submitted values and their errors.
  One rendering path, deterministic feedback, nothing ever lost.

This still unifies the mechanisms — both paths go through the one entity-page
renderer — it just refuses to make error feedback depend on best-effort
cache state.

**Multipart forms stay multipart.** `createAuthedFormRoute` is built on the
URL-encoded `AuthPolicy<"form">`/`FormParams` path, but the listing
create/edit forms are `enctype="multipart/form-data"` under
`CONTENT_MULTIPART` so image/attachment uploads arrive as `FormData`. The
adapter doesn't care (it only renders and points at an action URL), and the
listing POST keeps its multipart handler; if a second multipart entity ever
appears, add a `createAuthedFormRoute` multipart variant then — don't force
uploads through the form-only helper.

Conditional field visibility is untouched: the CSS `:has()` mixins operate
inside the form markup wherever it renders. Tabs neither add nor require JS —
**the whole framework is zero-JS**, plain links and full page loads, same as
the rest of the admin.

---

## Rendering: one strip, mobile-first

New template directory `src/ui/templates/admin/entity-pages/`:

- `render.tsx` — `entityPage(def, viewData)`: `Layout` → `AdminNav
  active={def.navActive}` → `<h1>{titleOf(e)}</h1>` → banner → tab strip →
  active tab's sections in order.
- `tab-strip.tsx` — a `<nav aria-label={t("entity.tabs")}>` of plain links;
  the active tab gets `aria-current="page"` and the `active` class. These are
  real links to real URLs, so **link semantics, not ARIA `tablist`** — ARIA
  tabs imply same-page panel switching and would misdescribe full page loads
  to screen readers.
- `SECTION_RENDERERS: Record<Section["kind"], …>` — each arm delegates to the
  existing shared component (`AccountStatementSection`, `ActivityLogTable`,
  the notes section, a new generic `SummaryTable`, a new `ActionList`).

CSS (in `style.scss`, one new block):

- `.entity-tabs` — horizontal row; on narrow screens `overflow-x: auto`
  with `-webkit-overflow-scrolling: touch` and no wrap, so five tabs stay one
  swipeable row instead of stacking into a wall (the admin nav's dual-DOM
  approach is unnecessary here — one DOM, responsive CSS).
- `.entity-danger-zone` — bordered, spaced-off container for `danger: true`
  actions.
- Reuse the existing table/`table-controls` styling for summary and sections —
  the components already carry it.

---

## i18n

Everything the framework renders is keyed: tab labels (`entity.tab.overview`,
`entity.tab.edit`, `entity.tab.ledger`, `entity.tab.activity`,
`entity.tab.actions`), action labels/descriptions, summary labels, danger-zone
copy — new catalog `src/locales/en/entity-pages.json`, per-entity keys in the
entity's existing catalog (`attendees.json`, listings keys).

The migration is also the i18n payoff: the attendee **edit form hardcodes
English today** ("Name", "Status & Balance", "Save Attendee",
`attendee-form.tsx:702-870`) and several save messages are literals
(`NO_LINES_ERROR` etc. in `attendee-form-routes.ts`). Moving each page onto
the framework includes moving its strings into the catalogs — the framework's
schema only *accepts* keys, so migrated pages can't quietly keep literals.
(`I18N_REPLACEMENTS` rebranding then covers these pages for free.)

---

## Route generation and the migration mechanics

`defineEntityPage` produces handlers the feature file binds under literal
route keys (see "Per-tab authorization" above for why the keys stay literal):

```ts
const attendeePage = defineEntityPage<AttendeeView>({ … });

// in the feature's defineRoutes map:
"GET /admin/attendees/:attendeeId": (request, { attendeeId }) =>
  attendeePage.renderTab(request, attendeeId, ""),
"GET /admin/attendees/:attendeeId/:tab": (request, { attendeeId, tab }) =>
  attendeePage.renderTab(request, attendeeId, tab),
```

- **Legacy URL compatibility**: migrated-away URLs 301 to their tab —
  `/admin/listing/:id/edit` → `/admin/listing/:id/edit` (already the Edit tab
  path — no redirect needed; the framework simply takes the route over), and
  `/admin/listing/:id/log` → `…/activity`. Anchor-style deep links
  (`#attendee-form`) keep working because the Edit tab renders the same ids.
- **POST routes are untouched by generation.** They live where they live,
  but every redirect target inside them is rewritten to
  `tabPath(def, id, slug)` — grep-able, and the only sanctioned way to build a
  tab URL.
- **`return_url` defaults**: sub-action links rendered by the framework
  (`ActionDef.href(e, ctx)`, notes `addHref`, ledger add/edit) receive
  `ctx.returnUrl` — the canonical current-tab URL — so a refund started from
  the Actions tab returns to the Actions tab with its flash, and a ledger edit
  started from the Ledger tab returns there.

---

## Migration plan (gradual, hardest first)

Each slice is a full PR that ends green (`deno task precommit`) with the page
fully on the framework — no half-migrated pages living in both worlds.

1. **Framework core + attendees** (the hardest page proves the design).
   Build `src/shared/entity-pages/{types,core,routes}.ts` +
   `src/ui/templates/admin/entity-pages/` + CSS + locale keys, then migrate
   the attendee page onto it: Overview (summary + bookings + answers + payment
   details + notes + activity preview + contact history panel), Edit (the
   bespoke form via the adapter), Ledger, Activity, Actions (resend, send
   text, refund, merge → link to the merge flow, danger: delete). Delete the
   monolithic composition from `attendee-form.tsx`; keep
   `attendee-detail.tsx`'s components as section content. i18n the form.
2. **Listings.** Collapse detail + edit into one entity page: Overview
   (details table + attendees + income reconciliation), Edit
   (`ListingFormSections` — ideally onto `defineForm` here, or via the adapter
   first and `defineForm` as a follow-up), Ledger, Activity (absorbs
   `/admin/listing/:id/log`), Actions (duplicate, scanner, questions, QR,
   email, refund-all; danger: deactivate/reactivate/delete). The children
   editor and income-adjust become `custom` sections on the tabs they belong
   to. `listings.tsx` should shrink by four figures of lines. Mind the whole
   deep-linkable URL surface, not just `/log`: the checked-in/out attendee
   filters `/admin/listing/:id/in` and `/admin/listing/:id/out`
   (`handleAdminListingGetIn/Out`) are linked from the check-in workflow, so
   they either stay as literal routes (literals beat `:tab` in the router, so
   coexistence is safe) or 301 to the Overview tab with a filter query —
   audit every `GET /admin/listing/:id/*` route the same way before deleting
   it. Per-tab auth applies here too: the page floor is the content guard so
   editors keep Edit; Overview/Activity carry staff-only `visible`
   predicates, Ledger stays owner-only exactly as `/admin/ledger*` is today,
   and the bare URL lands each role on its first visible tab.
3. **Modifiers** — the third copy of the composition; after listings this is
   mostly deletion.
4. **Groups, users, questions, built-sites, attendee-statuses, holidays,
   history/:hmac** — one small PR each, in whatever order they're next
   touched. Simple entities use two tabs (Overview, Edit) — the schema
   doesn't force empty tabs on anyone.
5. **(Follow-up, enabled but not required)** generalize `system_notes` from
   attendee-only to `(entity_type, entity_id)` so listings and modifiers get
   notes "for more system notes in more places" — the `notes` section kind
   already takes a loader, so this is a DB change plus one config line per
   entity.

---

## Testing & quality gates

Per AGENTS.md: 100% coverage, 0% duplication, 100% mutation kill on changed
files, `deno task precommit` final.

- **Core** (`core.ts`): table-driven tests — `tabPath` shapes, default-tab
  resolution, unknown-slug → null, `visible:false` tab → null even when named
  directly, action/summary filtering (a `visible:false` action never appears),
  exhaustiveness (a fixture def using every section kind renders every kind).
- **Renderer**: fixture `EntityPageDef` → assert tab strip order,
  `aria-current` on the active tab only, danger actions inside the danger
  zone, links absent (not just unstyled) when gated, banner present on every
  tab.
- **Routes**: per-entity — each tab 200s for an allowed role and the ledger
  tab 404s/hides for a non-owner (render as each role, not just owner);
  unknown id and unknown tab 404; POST save lands on the Edit tab with the
  flash; a sub-action round-trips `return_url` back to its origin tab.
- **Migration regression**: the attendee and listing test suites largely
  already assert content (summary values, action visibility, ledger rows);
  they get retargeted to tab URLs rather than rewritten — an intentional check
  that behaviour, not structure, is what moved.
- Targeted `deno task mutation` on `core.ts` and the renderer (visibility
  predicates and path building are classic survivor spots).

---

## Decisions

**Settled by this plan:**

- **D1 — Tabs, not nav.** Tab strip inside the page; the admin nav is
  untouched (`navActive` keeps the existing section highlighted).
- **D2 — Tabs are path segments** (`{base}/:id/:tab`), default tab at the bare
  id URL. Deep-linkable, PRG-native, back-button-correct.
- **D3 — Closed section union + exhaustive renderer Record**, with `custom` as
  the in-tab escape hatch. No plugin registry.
- **D4 — Zero JS.** Tabs are links; conditional form visibility stays
  CSS-`:has()`; existing progressive enhancements keep working per-element.
- **D5 — One feedback mechanism.** PRG + flash + saved-form stash everywhere;
  the attendee page's in-place re-render path is retired during its migration.
- **D6 — Link semantics** (`nav` + `aria-current="page"`), not ARIA tablist.
- **D7 — Overview is the default tab**; form saves land on the Edit tab.
- **D8 — Migration order**: attendees → listings → modifiers → the rest;
  each PR fully migrates its page.

**Open (recommendation in parentheses; sensible defaults chosen, not
blocking):**

- **O1 — Attendee create.** `/admin/attendees/new` is form-only and stays a
  plain (non-tabbed) page reusing the same form adapter (recommended), vs.
  rendering as a one-tab entity page for visual consistency.
- **O2 — Contact history placement.** Overview panel (recommended — it's
  read-mostly context) vs. its own tab; it's one config line either way.
- **O3 — Activity preview length on Overview** (recommended: 3 entries +
  "view all"), and whether the full Activity tab keeps the current 1000-entry
  limit or paginates (recommended: keep the limit now, paginate later).
- **O4 — Listing form onto `defineForm`** during slice 2 (recommended if it
  doesn't balloon the PR) vs. adapter-first with a follow-up PR.
